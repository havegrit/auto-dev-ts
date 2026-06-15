const DAILY_LIMIT: number | null = process.env.AUTO_DEV_DAILY_RUN_LIMIT != null
  ? Number(process.env.AUTO_DEV_DAILY_RUN_LIMIT)
  : null;
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
  allow(): boolean {
    resetIfNewDay();
    return DAILY_LIMIT === null || runCount < DAILY_LIMIT;
  },
  recordRun(): void { resetIfNewDay(); runCount++; },
  stats(): { count: number; limit: number | null; date: string } {
    resetIfNewDay();
    return { count: runCount, limit: DAILY_LIMIT, date: dayKey };
  },
};
