function write(level: string, ctx: Record<string, unknown>, msg: string) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, ...ctx, msg });
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export const log = {
  info:  (ctx: Record<string, unknown>, msg: string) => write('info',  ctx, msg),
  warn:  (ctx: Record<string, unknown>, msg: string) => write('warn',  ctx, msg),
  error: (ctx: Record<string, unknown>, msg: string) => write('error', ctx, msg),
  debug: (ctx: Record<string, unknown>, msg: string) => write('debug', ctx, msg),
};
