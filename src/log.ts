export type Level = 'debug' | 'info' | 'warn' | 'error';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const bold = paint('1');
const red = paint('31');
const yellow = paint('33');
const green = paint('32');
const cyan = paint('36');

let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function isVerbose(): boolean {
  return verbose;
}

export const log = {
  debug(msg: string, ...rest: unknown[]): void {
    if (verbose) console.error(dim(`debug ${msg}`), ...rest);
  },
  info(msg: string, ...rest: unknown[]): void {
    console.log(msg, ...rest);
  },
  step(msg: string, ...rest: unknown[]): void {
    console.log(cyan('•'), msg, ...rest);
  },
  ok(msg: string, ...rest: unknown[]): void {
    console.log(green('✓'), msg, ...rest);
  },
  warn(msg: string, ...rest: unknown[]): void {
    console.error(yellow('!'), msg, ...rest);
  },
  error(msg: string, ...rest: unknown[]): void {
    console.error(red('✗'), msg, ...rest);
  },
  heading(msg: string): void {
    console.log(bold(msg));
  },
  dim,
  bold,
};
