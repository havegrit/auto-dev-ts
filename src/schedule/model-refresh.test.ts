import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  loadModelsFromCli: vi.fn(async () => {}),
}));

vi.mock('node-cron', () => ({ default: { schedule: mocks.schedule } }));
vi.mock('../lib/model-config.js', () => ({ loadModelsFromCli: mocks.loadModelsFromCli }));
vi.mock('../lib/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe('model refresh schedule', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.schedule.mockReset();
    mocks.loadModelsFromCli.mockClear();
  });

  it('refreshes model catalogs every Sunday at 9 AM Seoul time', async () => {
    const { startModelRefreshSchedule } = await import('./model-refresh.js');
    startModelRefreshSchedule();

    expect(mocks.schedule).toHaveBeenCalledWith('0 9 * * 0', expect.any(Function), { timezone: 'Asia/Seoul' });
    const callback = mocks.schedule.mock.calls[0][1] as () => Promise<void>;
    await callback();
    expect(mocks.loadModelsFromCli).toHaveBeenCalledOnce();
  });

  it('registers the schedule only once', async () => {
    const { startModelRefreshSchedule } = await import('./model-refresh.js');
    startModelRefreshSchedule();
    startModelRefreshSchedule();
    expect(mocks.schedule).toHaveBeenCalledOnce();
  });
});
