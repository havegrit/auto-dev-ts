import test from 'node:test';
import assert from 'node:assert/strict';
import { latestExchangeRate } from '../src/rates.ts';

test('returns a positive live USD/KRW exchange rate', () => {
  assert.ok(latestExchangeRate('USD', 'KRW') > 0);
});
