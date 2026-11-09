/**
 * Byte chunks from a raw-mode terminal, turned into key events. Terminal UI
 * spec §4.2. Unknown sequences are dropped, never guessed at.
 */

export type NamedKey =
  | "enter"
  | "esc"
  | "tab"
  | "backtab"
  | "backspace"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown";

export type Key = { kind: "char"; char: string } | { kind: "named"; name: NamedKey } | { kind: "ctrl"; char: string };

const CSI: Record<string, NamedKey> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "backtab",
  "1~": "home",
  "7~": "home",
  "4~": "end",
  "8~": "end",
  "5~": "pageup",
  "6~": "pagedown",
};

const SS3: Record<string, NamedKey> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };

/**
 * Keeps an escape sequence that a read split in two, so `\x1b[` at the end of
 * one chunk and `A` at the start of the next is still one up arrow. A lone
 * ESC at the end of a chunk is the Esc key: terminals write a whole sequence
 * at once, so waiting for more would only make Esc feel slow.
 */
const PASTE_START = "200~";
const PASTE_END = "\x1b[201~";

export type Input = Key | { kind: "paste"; text: string };

export class KeyParser {
  private pending = "";
  /** Text inside a bracketed paste, while its end marker has not arrived. */
  private paste: string | null = null;

  feed(chunk: string): Input[] {
    const input = this.pending + chunk;
    this.pending = "";
    const keys: Input[] = [];
    let i = 0;
    while (i < input.length) {
      if (this.paste !== null) {
        // Everything up to the end marker is text, Enter and Tab included.
        const end = input.indexOf(PASTE_END, i);
        if (end === -1) {
          // Hold back a tail that could be the start of the end marker.
          let keep = 0;
          for (let n = Math.min(PASTE_END.length - 1, input.length - i); n > 0; n -= 1) {
            if (PASTE_END.startsWith(input.slice(input.length - n))) {
              keep = n;
              break;
            }
          }
          this.paste += input.slice(i, input.length - keep);
          this.pending = input.slice(input.length - keep);
          return keys;
        }
        keys.push({ kind: "paste", text: this.paste + input.slice(i, end) });
        this.paste = null;
        i = end + PASTE_END.length;
        continue;
      }
      const c = input[i]!;
      if (c === "\x1b") {
        const next = input[i + 1];
        if (next === undefined) {
          keys.push({ kind: "named", name: "esc" });
          i += 1;
          continue;
        }
        if (next === "[" || next === "O") {
          // CSI: parameter bytes 0x30-0x3f, intermediates 0x20-0x2f, one final 0x40-0x7e.
          let j = i + 2;
          while (j < input.length && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x3f) j += 1;
          if (j >= input.length) {
            this.pending = input.slice(i);
            break;
          }
          const body = input.slice(i + 2, j + 1);
          if (next === "[" && body === PASTE_START) {
            this.paste = "";
            i = j + 1;
            continue;
          }
          const name = next === "[" ? CSI[body] : SS3[body];
          if (name) keys.push({ kind: "named", name });
          i = j + 1;
          continue;
        }
        if (next === "\x1b") {
          keys.push({ kind: "named", name: "esc" });
          i += 1;
          continue;
        }
        // Alt plus a key: not a key the UI uses.
        i += 2;
        continue;
      }
      if (c === "\r" || c === "\n") keys.push({ kind: "named", name: "enter" });
      else if (c === "\t") keys.push({ kind: "named", name: "tab" });
      else if (c === "\x7f" || c === "\b") keys.push({ kind: "named", name: "backspace" });
      else if (c.charCodeAt(0) < 0x20) keys.push({ kind: "ctrl", char: String.fromCharCode(c.charCodeAt(0) + 0x60) });
      else {
        // One code point, so a character outside the BMP stays whole.
        const point = String.fromCodePoint(input.codePointAt(i)!);
        keys.push({ kind: "char", char: point });
        i += point.length;
        continue;
      }
      i += 1;
    }
    return keys;
  }
}

export function isChar(key: Input, char: string): boolean {
  return key.kind === "char" && key.char === char;
}

export function isNamed(key: Input, name: NamedKey): boolean {
  return key.kind === "named" && key.name === name;
}
