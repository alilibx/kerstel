/** The working directory, or null when it was deleted or is unreadable; it is audit-only. */
export function currentDir(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}
