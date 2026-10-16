import test from 'node:test';
import assert from 'node:assert/strict';
import { isEven } from '../src/math.ts';

test('isEven identifies positive, zero, and negative integers', () => {
  assert.equal(isEven(0), true);
  assert.equal(isEven(2), true);
  assert.equal(isEven(-4), true);
  assert.equal(isEven(1), false);
  assert.equal(isEven(-3), false);
});
