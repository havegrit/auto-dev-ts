import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createStderrCollector, withStderr } from './cli-stderr.js';

describe('createStderrCollector', () => {
  it('collects non-empty trimmed stderr chunks', () => {
    const c = createStderrCollector();
    c.onStderr('  line one \n');
    c.onStderr('   ');
    c.onStderr('line two');
    expect(c.text()).toBe('line one\nline two');
  });

  it('is empty when nothing was collected', () => {
    expect(createStderrCollector().text()).toBe('');
  });
});

describe('withStderr', () => {
  it('appends captured stderr so the real cause is visible', () => {
    const e = withStderr(
      new Error('Claude Code process exited with code 1'),
      '--dangerously-skip-permissions cannot be used with root',
    );
    expect(e.message).toContain('exited with code 1');
    expect(e.message).toContain('cannot be used with root');
  });

  it('returns the original error untouched when no stderr was captured', () => {
    const orig = new Error('boom');
    expect(withStderr(orig, '')).toBe(orig);
  });

  it('wraps non-Error throwables into an Error', () => {
    expect(withStderr('plain string', 'ctx')).toBeInstanceOf(Error);
  });
});
