/** Every colour and symbol the CLI prints comes from here. Spec §4.1. */

export interface ThemeEnv {
  isTTY: boolean;
  noColor: boolean;
  truecolor: boolean;
}

export interface Theme {
  color: boolean;
  accent: (text: string) => string;
  dim: (text: string) => string;
  bold: (text: string) => string;
  red: (text: string) => string;
  yellow: (text: string) => string;
  green: (text: string) => string;
}

export function detectTheme(
  stream: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout,
  env: Record<string, string | undefined> = process.env,
): ThemeEnv {
  return {
    isTTY: stream.isTTY === true,
    noColor: Boolean(env.NO_COLOR),
    truecolor: env.COLORTERM === "truecolor" || env.COLORTERM === "24bit",
  };
}

export function makeTheme(env: ThemeEnv): Theme {
  const color = env.isTTY && !env.noColor;
  const sgr = (open: string, close: string) => (text: string) =>
    color ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  return {
    color,
    accent: color && env.truecolor ? sgr("38;2;74;222;128", "39") : sgr("32", "39"),
    dim: sgr("2", "22"),
    bold: sgr("1", "22"),
    red: sgr("31", "39"),
    yellow: sgr("33", "39"),
    green: sgr("32", "39"),
  };
}

export const theme: Theme = makeTheme(detectTheme());

export const SYMBOLS = { pass: "✓", warn: "!", problem: "✗", info: "·" } as const;
