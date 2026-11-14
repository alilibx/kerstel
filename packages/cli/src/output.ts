import { SYMBOLS, theme } from "./ui/theme";

export const dim = theme.dim;
export const bold = theme.bold;
export const green = theme.green;
export const red = theme.red;
export const yellow = theme.yellow;

export function ok(message: string): void {
  console.log(`${green(SYMBOLS.pass)}  ${message}`);
}

export function fail(message: string): void {
  console.log(`${red(SYMBOLS.problem)}  ${message}`);
}

export function info(message: string): void {
  console.log(`${dim(SYMBOLS.info)}  ${message}`);
}

/**
 * `text` without control characters (C0, DEL, C1) or the invisible marks that
 * reorder or hide text, for printing something a server sent, such as its
 * version: an escape sequence in it must not reach the terminal.
 */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "");
}

/** Masks a secret for display. Never reveals length beyond a fixed width. */
export function mask(): string {
  return "••••••••••••";
}
