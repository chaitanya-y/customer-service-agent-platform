import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

const schemaPath = new URL('../../contracts/tools/delivery-order-ownership/v1/delivery-order-ownership.schema.json', import.meta.url);
const valid = { schemaVersion: '1', reference: 'ORDER-123' };

test('delivery ownership contract permits only the owned order reference', async () => {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);

  assert.equal(validate(valid), true);
  for (const payload of [
    { ...valid, source: { orderId: 'private' } },
    { ...valid, customerRef: { customerId: 'private' } },
    { ...valid, status: 'Delivered' },
    { ...valid, payments: [] },
    { ...valid, schemaVersion: '2' },
    { ...valid, reference: '' },
    { ...valid, reference: 'x'.repeat(101) },
    { ...valid, reference: 'bad reference' },
  ]) {
    assert.equal(validate(payload), false, JSON.stringify(payload).slice(0, 150));
  }
});
