import test from 'node:test';
import assert from 'node:assert/strict';
import { isEven } from '../src/math.ts';

test('isEven identifies a positive even integer', () => {
  assert.equal(isEven(2), true);
});
