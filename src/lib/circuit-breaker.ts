const FALLBACK_MS = Number(
  process.env.AUTO_DEV_CIRCUIT_BREAKER_FALLBACK_MS ?? String(5 * 60 * 1000),
);

let openUntilMs = 0;

function toMs(resetAt: number): number {
  // unix seconds (< 1e11) → ms, already ms (>= 1e11) → as-is
  return resetAt < 1e11 ? resetAt * 1000 : resetAt;
}

export const circuitBreaker = {
  isOpen(): boolean {
    return Date.now() < openUntilMs;
  },

  openUntil(resetAtMs: number): void {
    const ms = toMs(resetAtMs);
    if (ms > openUntilMs) openUntilMs = ms;
  },

  openForFallback(): void {
    const ms = Date.now() + FALLBACK_MS;
    if (ms > openUntilMs) openUntilMs = ms;
  },

  reset(): void {
    openUntilMs = 0;
  },

  stats(): { state: 'OPEN' | 'CLOSED'; openUntil: string | null; remainingMs: number } {
    const now = Date.now();
    const open = now < openUntilMs;
    return {
      state: open ? 'OPEN' : 'CLOSED',
      openUntil: open ? new Date(openUntilMs).toISOString() : null,
      remainingMs: open ? openUntilMs - now : 0,
    };
  },
};
