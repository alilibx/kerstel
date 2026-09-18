export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command without a shell. Secret material is passed on stdin, never as
 * an argv entry, so it cannot leak through the process table.
 */
export async function run(cmd: string[], stdin?: string): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function commandExists(name: string): Promise<boolean> {
  const probe = process.platform === "win32" ? ["where", name] : ["which", name];
  try {
    return (await run(probe)).code === 0;
  } catch {
    return false;
  }
}
