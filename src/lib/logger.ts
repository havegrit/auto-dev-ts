function write(level: string, ctx: Record<string, unknown>, msg: string) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, ...ctx, msg });
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const log = {
  info:  (ctx: Record<string, unknown>, msg: string) => write('info',  ctx, msg),
  warn:  (ctx: Record<string, unknown>, msg: string) => write('warn',  ctx, msg),
  error: (ctx: Record<string, unknown>, msg: string) => write('error', ctx, msg),
  debug: (ctx: Record<string, unknown>, msg: string) => write('debug', ctx, msg),
};
