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

/** Masks a secret for display. Never reveals length beyond a fixed width. */
export function mask(): string {
  return "••••••••••••";
}
