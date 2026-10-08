import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toOrderTotal } from '../src/order-total.js';

test('order-total projection rejects a non-string source reference', () => {
  assert.throws(() => toOrderTotal({
    reference: null,
    total: { amountMinor: 1_234, currency: 'USD' },
  } as never));
});
