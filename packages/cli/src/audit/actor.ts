import { currentDir } from "../current-dir";
import { processChain, systemProcessLookup } from "./chain";

/** Who is writing to the vault: stamped on every audit row the vault records itself. */
export interface AuditActor {
  pid: number;
  processName: string;
  cwd: string | null;
  /** The programs that started this process, nearest first. Never throws. */
  chain(): string[];
}

/**
 * The actor for a command run: this process. The chain is read from the
 * operating system on the first row written, once, so opening a vault that
 * never writes costs nothing.
 */
export function cliActor(): AuditActor {
  let chain: string[] | null = null;
  return {
    pid: process.pid,
    processName: "kerstel",
    cwd: currentDir(),
    chain() {
      chain ??= processChain(process.pid, systemProcessLookup());
      return chain;
    },
  };
}
