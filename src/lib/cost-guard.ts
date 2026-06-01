const DAILY_LIMIT = Number(process.env.AUTO_DEV_DAILY_RUN_LIMIT ?? '100');
const ZONE = 'Asia/Seoul';

let dayKey = today();
let runCount = 0;

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());
}

function resetIfNewDay() {
  const d = today();
  if (d !== dayKey) { dayKey = d; runCount = 0; }
}

export const costGuard = {
  allow(): boolean { resetIfNewDay(); return runCount < DAILY_LIMIT; },
  recordRun(): void { resetIfNewDay(); runCount++; },
  stats(): { count: number; limit: number; date: string } {
    resetIfNewDay();
    return { count: runCount, limit: DAILY_LIMIT, date: dayKey };
  },
};
