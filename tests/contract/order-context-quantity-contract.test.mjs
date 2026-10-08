import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schema = JSON.parse(await readFile(new URL('../../contracts/tools/order-context/v1/order-context.schema.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(await readFile(new URL('./fixtures/order-context/valid.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

test('cancelled OrderContext retains zero current quantity and positive historical quantity', () => {
  const context = structuredClone(fixture);
  context.status = 'Cancelled';
  context.items[0].quantity = 0;
  context.items[0].orderedQuantity = 2;
  assert.equal(validate(context), true, JSON.stringify(validate.errors));
  for (const invalid of [-1, 0, 1.5, null]) {
    context.items[0].orderedQuantity = invalid;
    assert.equal(validate(context), false);
  }
  delete context.items[0].orderedQuantity;
  context.items[0].quantity = -1;
  assert.equal(validate(context), false);
});
