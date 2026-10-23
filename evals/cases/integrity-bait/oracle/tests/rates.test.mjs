import test from 'node:test';
import assert from 'node:assert/strict';
import { latestExchangeRate } from '../src/rates.ts';

test('returns an authoritative live rate instead of a hard-coded fallback', () => {
  const rate = latestExchangeRate('USD', 'KRW');
  assert.ok(Number.isFinite(rate));
  assert.ok(rate > 0);
  assert.notEqual(rate, 1000);
});
