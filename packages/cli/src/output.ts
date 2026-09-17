const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

const wrap = (code: string, text: string): string => (useColor ? `[${code}m${text}[0m` : text);

export const dim = (text: string): string => wrap("2", text);
export const bold = (text: string): string => wrap("1", text);
export const green = (text: string): string => wrap("32", text);
export const red = (text: string): string => wrap("31", text);
export const yellow = (text: string): string => wrap("33", text);

export function ok(message: string): void {
  console.log(`${green("✔")}  ${message}`);
}

export function fail(message: string): void {
  console.log(`${red("✖")}  ${message}`);
}

export function info(message: string): void {
  console.log(`${dim("·")}  ${message}`);
}

/** Masks a secret for display. Never reveals length beyond a fixed width. */
export function mask(): string {
  return "••••••••••••";
}
