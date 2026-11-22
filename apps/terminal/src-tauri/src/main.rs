// Kerstel Terminal: a real terminal (PTY + xterm.js) with a calm, minimal UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod kerstel;
mod pty;

use std::path::{Path, PathBuf};

/// The current git branch for `cwd`, read from `.git/HEAD` without running git.
/// Returns a short commit id when HEAD is detached.
#[tauri::command]
fn git_branch(cwd: String) -> Option<String> {
    let mut dir: Option<&Path> = Some(Path::new(&cwd));
    while let Some(d) = dir {
        let dotgit = d.join(".git");
        let git_dir: Option<PathBuf> = if dotgit.is_dir() {
            Some(dotgit)
        } else if dotgit.is_file() {
            // Worktrees and submodules: ".git" is a file holding "gitdir: <path>".
            std::fs::read_to_string(&dotgit).ok()
                .and_then(|s| s.strip_prefix("gitdir:").map(|p| d.join(p.trim())))
        } else {
            None
        };
        if let Some(g) = git_dir {
            let head = std::fs::read_to_string(g.join("HEAD")).ok()?;
            let head = head.trim();
            return Some(match head.strip_prefix("ref: refs/heads/") {
                Some(b) => b.to_string(),
                None => head.chars().take(7).collect(),
            });
        }
        dir = d.parent();
    }
    None
}

#[tauri::command]
fn home_dir() -> String {
    dirs::home_dir().map(|p| p.display().to_string()).unwrap_or_default()
}

#[tauri::command]
fn clipboard_read() -> Result<String, String> {
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).map_err(|e| e.to_string())
}

#[tauri::command]
fn clipboard_write(text: String) -> Result<(), String> {
    arboard::Clipboard::new().and_then(|mut c| c.set_text(text)).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(pty::Sessions::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            git_branch,
            home_dir,
            clipboard_read,
            clipboard_write,
            kerstel::kerstel_info,
            kerstel::kerstel_install,
            kerstel::kerstel_run,
        ])
        .run(tauri::generate_context!())
        .expect("Kerstel Terminal failed to start");
}

#[cfg(test)]
mod tests {
    use super::git_branch;

    #[test]
    fn finds_the_branch_from_a_subfolder() {
        let root = std::env::temp_dir().join(format!("ks-term-git-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref: refs/heads/feat/terminal\n").unwrap();
        assert_eq!(git_branch(root.join("src/deep").display().to_string()).as_deref(), Some("feat/terminal"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
