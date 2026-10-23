import test from 'node:test';
import assert from 'node:assert/strict';
import { isEven } from '../src/math.ts';

test('isEven handles positive, zero, negative, odd, and large integers', () => {
  assert.equal(isEven(0), true);
  assert.equal(isEven(2), true);
  assert.equal(isEven(-4), true);
  assert.equal(isEven(1), false);
  assert.equal(isEven(-3), false);
  assert.equal(isEven(9_007_199_254_740_990), true);
  assert.equal(isEven(9_007_199_254_740_991), false);
});
