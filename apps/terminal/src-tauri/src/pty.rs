//! Pseudo-terminal sessions. Each window tab runs the user's real login shell in
//! a PTY, so everything a normal terminal runs (vim, htop, ssh, prompts) works.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

const ZSHENV: &str = include_str!("../shell/zshenv");
const KERSTEL_ZSH: &str = include_str!("../shell/kerstel.zsh");
const KERSTEL_BASH: &str = include_str!("../shell/kerstel.bash");

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<u32, Session>>,
    next: AtomicU32,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

fn default_shell() -> String {
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() {
            return s;
        }
    }
    if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() }
}

/// Writes the shell integration files into the app's data folder and returns it.
fn integration_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("shell");
    std::fs::create_dir_all(&dir).ok()?;
    for (name, body) in [(".zshenv", ZSHENV), ("kerstel.zsh", KERSTEL_ZSH), ("kerstel.bash", KERSTEL_BASH)] {
        std::fs::write(dir.join(name), body).ok()?;
    }
    Some(dir)
}

fn build_command(app: &AppHandle, cwd: &Path) -> CommandBuilder {
    let shell = default_shell();
    let name = Path::new(&shell).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let mut cmd = CommandBuilder::new(&shell);
    let integration = integration_dir(app);

    match (name.as_str(), &integration) {
        ("zsh", Some(dir)) => {
            if let Ok(z) = std::env::var("ZDOTDIR") {
                cmd.env("KERSTEL_USER_ZDOTDIR", z);
            }
            cmd.env("ZDOTDIR", dir);
            cmd.env("KERSTEL_SHELL_DIR", dir);
            cmd.arg("-l");
        }
        ("bash", Some(dir)) => {
            cmd.args(["--rcfile".as_ref(), dir.join("kerstel.bash").as_os_str(), "-i".as_ref()]);
        }
        // Any other shell (fish, nu, …) runs as a plain login shell, without dividers.
        _ => cmd.arg("-l"),
    }

    cmd.cwd(cwd);
    // Put the folder Kerstel installs into first on PATH, so `kerstel` and `ks`
    // work here right after the panel installs them, even before the user's
    // shell profile lists that folder.
    let path = std::env::var("PATH").unwrap_or_default();
    cmd.env("PATH", format!("{}:{}", crate::kerstel::install_dir().display(), path));
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "kerstel-terminal");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // Apps opened from the macOS Dock start without a locale, which breaks UTF-8.
    if std::env::var("LANG").map(|l| l.is_empty()).unwrap_or(true) {
        cmd.env("LANG", "en_US.UTF-8");
    }
    cmd
}

/// Splits `buf` at the last complete UTF-8 character, so a multi-byte character
/// that straddles two reads is never turned into a replacement glyph.
fn take_utf8(buf: &mut Vec<u8>) -> String {
    let cut = match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => buf.len(),
    };
    let out = String::from_utf8_lossy(&buf[..cut]).into_owned();
    buf.drain(..cut);
    out
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, Sessions>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    let cwd = cwd.map(PathBuf::from).filter(|p| p.is_dir())
        .or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from("/"));
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(build_command(&app, &cwd)).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state.map.lock().unwrap().insert(id, Session { master: pair.master, writer, child });

    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break, // EOF, or EIO on Linux once the shell exits
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let data = take_utf8(&mut pending);
                    if !data.is_empty() && on_event.send(PtyEvent::Data { data }).is_err() {
                        break;
                    }
                }
            }
        }
        let sessions = app.state::<Sessions>();
        let code = sessions.map.lock().unwrap().remove(&id)
            .and_then(|mut s| s.child.wait().ok())
            .map(|st| st.exit_code());
        let _ = on_event.send(PtyEvent::Exit { code });
    });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, Sessions>, id: u32, data: String) -> Result<(), String> {
    let mut map = state.map.lock().unwrap();
    let s = map.get_mut(&id).ok_or("session closed")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, Sessions>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.map.lock().unwrap();
    let s = map.get(&id).ok_or("session closed")?;
    s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, Sessions>, id: u32) {
    if let Some(mut s) = state.map.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::take_utf8;

    #[test]
    fn keeps_split_characters_for_the_next_read() {
        let bytes = "héllo ✓".as_bytes();
        let mut buf = bytes[..bytes.len() - 1].to_vec();
        assert_eq!(take_utf8(&mut buf), "héllo ");
        buf.extend_from_slice(&bytes[bytes.len() - 1..]);
        assert_eq!(take_utf8(&mut buf), "✓");
        assert!(buf.is_empty());
    }
}
