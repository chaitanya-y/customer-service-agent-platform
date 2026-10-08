import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

const schemaPath = new URL('../../contracts/tools/order-items/v1/order-items.schema.json', import.meta.url);
const item = { name: 'Laptop 13 inch 8GB', quantity: 1 };
const valid = { schemaVersion: '1', reference: 'ORDER-123', items: [item] };

test('order-items contract accepts only bounded customer-safe items', async () => {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);

  assert.equal(validate(valid), true);
  assert.equal(validate({ ...valid, items: Array.from({ length: 20 }, () => item) }), true);
  for (const payload of [
    { ...valid, payments: [] },
    { ...valid, customerRef: { customerId: 'private' } },
    { ...valid, items: [{ ...item, sku: 'private' }] },
    { ...valid, status: 'Cancelled' },
    { ...valid, items: [{ name: 'Laptop', quantity: 0, orderedQuantity: 2 }] },
    { ...valid, items: [{ ...item, orderedQuantity: 2 }] },
    { ...valid, items: [] },
    { ...valid, items: Array.from({ length: 21 }, () => item) },
    { ...valid, items: [{ name: ' ', quantity: 1 }] },
    { ...valid, items: [{ name: 'x'.repeat(301), quantity: 1 }] },
    { ...valid, items: [{ name: 'Laptop', quantity: 0 }] },
    { ...valid, items: [{ name: 'Laptop', quantity: 10001 }] },
    { ...valid, items: [{ name: 'Laptop', quantity: 1.5 }] },
    { ...valid, reference: '' },
    { ...valid, reference: 'x'.repeat(101) },
  ]) {
    assert.equal(validate(payload), false, JSON.stringify(payload).slice(0, 150));
  }
});
