import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepRunningAfterSessionDisconnect } from './session-lifecycle.js';

describe('session lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('installs a SIGHUP handler so SSH disconnect does not stop the server', () => {
    const on = vi.spyOn(process, 'on');

    keepRunningAfterSessionDisconnect();

    expect(on).toHaveBeenCalledWith('SIGHUP', expect.any(Function));
  });
});
