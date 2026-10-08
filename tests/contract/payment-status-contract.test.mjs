import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

const schemaPath = new URL('../../contracts/tools/payment-status/v1/payment-status.schema.json', import.meta.url);
const valid = {
  schemaVersion: '1', reference: 'ORDER-123', paymentStatus: 'PAID', refundStatus: 'PENDING',
};

test('payment-status contract exposes only bounded aggregate states', async () => {
  const validate = new Ajv2020({ strict: true }).compile(JSON.parse(await readFile(schemaPath, 'utf8')));
  assert.equal(validate(valid), true);
  for (const payload of [
    { ...valid, paymentId: 'private' },
    { ...valid, transactionReference: 'private' },
    { ...valid, method: 'card' },
    { ...valid, refunds: [] },
    { ...valid, customerId: '2' },
    { ...valid, amountMinor: 1000 },
    { ...valid, paymentStatus: 'UNKNOWN' },
    { ...valid, refundStatus: 'SETTLED' },
    { ...valid, reference: '' },
    { ...valid, reference: 'x'.repeat(101) },
  ]) assert.equal(validate(payload), false, JSON.stringify(payload).slice(0, 160));
});
