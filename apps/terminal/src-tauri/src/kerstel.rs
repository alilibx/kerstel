//! The bundled Kerstel CLI. The app carries a `kerstel` binary next to its own
//! executable; it installs it where `install.sh` would (~/.local/bin, or
//! KERSTEL_INSTALL_DIR) so `kerstel` and `ks` work in every terminal and wired
//! package.json scripts keep a stable path. The panel then runs the installed
//! copy, never the bundled one, so there is one Kerstel on the machine.

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Commands the panel may run without a terminal. Everything interactive
/// (sync setup, join, add-device…) is typed into the terminal instead, where
/// the person sees and answers the CLI's own prompts.
const ALLOWED: &[&[&str]] = &[
    &["--version"],
    &["ls", "--json"],
    &["get"],
    &["set"],
    &["rm"],
    &["sync", "status", "--json"],
    &["sync", "devices", "--json"],
];

pub fn install_dir() -> PathBuf {
    match std::env::var("KERSTEL_INSTALL_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).join(".local/bin"),
    }
}

/// The binary shipped inside the app. Tauri puts external binaries next to the
/// main executable, without the target triple in the name.
fn bundled() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.join("kerstel");
    path.is_file().then_some(path)
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// The installed Kerstel: the install folder first, then whatever the user's
/// login shell finds (apps opened from the Dock don't get the shell's PATH).
fn installed() -> Option<PathBuf> {
    let p = install_dir().join("kerstel");
    if is_executable(&p) {
        return Some(p);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = Command::new(shell).args(["-lc", "command -v kerstel"]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let found = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && found.starts_with('/')).then(|| PathBuf::from(found))
}

fn version_of(p: &Path) -> Option<String> {
    let out = Command::new(p).arg("--version").env("NO_COLOR", "1").stdin(Stdio::null()).output().ok()?;
    let v = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
    (!v.is_empty()).then_some(v)
}

/// `a` is older than `b`, comparing dotted numbers ("0.4.0" < "0.5.0").
/// Anything that isn't plain numbers compares as not older.
pub fn older(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Option<Vec<u64>> { s.trim_start_matches('v').split(['.', '-']).take(3).map(|x| x.parse().ok()).collect() };
    match (parse(a), parse(b)) {
        (Some(a), Some(b)) => a < b,
        _ => false,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    /// Path of the installed `kerstel`, if any.
    path: Option<String>,
    version: Option<String>,
    bundled_version: Option<String>,
    install_dir: String,
    /// The bundled copy is newer than the installed one (or nothing is installed).
    can_install: bool,
}

fn info_now() -> Info {
    let path = installed();
    let version = path.as_deref().and_then(version_of);
    let bundled_version = bundled().as_deref().and_then(version_of);
    let can_install = match (&version, &bundled_version) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(v), Some(b)) => older(v, b),
    };
    Info {
        path: path.map(|p| p.display().to_string()),
        version,
        bundled_version,
        install_dir: install_dir().display().to_string(),
        can_install,
    }
}

#[tauri::command]
pub async fn kerstel_info() -> Info {
    tauri::async_runtime::spawn_blocking(info_now).await.unwrap_or_else(|_| info_now())
}

/// Copies the bundled binary to the install folder the way install.sh does:
/// stage next to the destination, then rename, then add the `ks` shortcut.
fn install_now() -> Result<Info, String> {
    let src = bundled().ok_or("This copy of Kerstel Terminal doesn't include Kerstel.")?;
    let dir = install_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let dest = dir.join("kerstel");
    let staged = dir.join(format!(".kerstel-install.{}", std::process::id()));
    std::fs::copy(&src, &staged).map_err(|e| format!("Could not write to {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&staged, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&staged);
        e.to_string()
    })?;
    if version_of(&dest).is_none() {
        return Err(format!("Installed {}, but it did not run.", dest.display()));
    }
    // Same rule as install.sh: never replace a `ks` that is something else.
    #[cfg(unix)]
    {
        let ks = dir.join("ks");
        if std::fs::symlink_metadata(&ks).is_err() {
            let _ = std::os::unix::fs::symlink("kerstel", &ks);
        }
    }
    Ok(info_now())
}

#[tauri::command]
pub async fn kerstel_install() -> Result<Info, String> {
    tauri::async_runtime::spawn_blocking(install_now).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Output {
    code: i32,
    stdout: String,
    stderr: String,
}

fn allowed(args: &[String]) -> bool {
    ALLOWED.iter().any(|prefix| prefix.len() <= args.len() && prefix.iter().zip(args).all(|(p, a)| p == a))
}

/// Runs the installed Kerstel. `stdin` carries a secret for `set`, so a value
/// never appears in argv, shell history or `ps`.
fn run_now(args: Vec<String>, stdin: Option<String>) -> Result<Output, String> {
    if !allowed(&args) {
        return Err(format!("kerstel {} can't run from the panel.", args.join(" ")));
    }
    let bin = installed().ok_or("Kerstel isn't installed.")?;
    let mut child = Command::new(bin)
        .args(&args)
        .env("NO_COLOR", "1")
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(input) = stdin {
        let mut pipe = child.stdin.take().ok_or("no stdin")?;
        pipe.write_all(input.as_bytes()).map_err(|e| e.to_string())?;
    } // the pipe closes here, so `set` sees the end of the value
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(Output {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

#[tauri::command]
pub async fn kerstel_run(args: Vec<String>, stdin: Option<String>) -> Result<Output, String> {
    tauri::async_runtime::spawn_blocking(move || run_now(args, stdin)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{allowed, older};

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn compares_versions() {
        assert!(older("0.4.0", "0.5.0"));
        assert!(older("0.4.0", "0.4.1"));
        assert!(!older("0.5.0", "0.4.9"));
        assert!(!older("0.4.0", "0.4.0"));
        assert!(!older("dev", "0.4.0"));
    }

    #[test]
    fn only_runs_listed_commands() {
        assert!(allowed(&v(&["ls", "--json"])));
        assert!(allowed(&v(&["get", "global/KEY", "--reveal"])));
        assert!(allowed(&v(&["sync", "status", "--json"])));
        assert!(!allowed(&v(&["sync", "off"])));
        assert!(!allowed(&v(&["uninstall", "--yes"])));
        assert!(!allowed(&v(&["sync"])));
        assert!(!allowed(&v(&[])));
    }
}
