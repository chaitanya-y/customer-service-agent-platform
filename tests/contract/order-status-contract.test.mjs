import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

const schemaPath = new URL('../../contracts/tools/order-status/v1/order-status.schema.json', import.meta.url);
const valid = {
  schemaVersion: '1',
  reference: 'ORDER-123',
  status: 'Delivered',
  fulfillments: [{ status: 'Shipped', trackingCode: null }],
};

test('order-status contract accepts only the customer-safe status projection', async () => {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);

  assert.equal(validate(valid), true);
  for (const payload of [
    { ...valid, payments: [] },
    { ...valid, customerRef: { customerId: 'customer-private' } },
    { ...valid, fulfillments: [{ ...valid.fulfillments[0], fulfillmentId: 'private' }] },
  ]) {
    assert.equal(validate(payload), false);
  }
});
