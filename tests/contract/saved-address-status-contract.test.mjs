import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

test('saved address contract excludes personal data and impossible zero/default combinations', async () => {
  const schema = JSON.parse(await readFile(new URL('../../contracts/tools/saved-address-status/v1/saved-address-status.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const empty = { schemaVersion: '1', savedAddressCount: 0, hasDefaultShippingAddress: false, hasDefaultBillingAddress: false };
  assert.equal(validate(empty), true);
  assert.equal(validate({ ...empty, savedAddressCount: 2, hasDefaultShippingAddress: true }), true);
  for (const value of [
    { ...empty, customerId: 'private' }, { ...empty, addresses: [] },
    { ...empty, savedAddressCount: -1 }, { ...empty, savedAddressCount: 1.5 },
    { ...empty, savedAddressCount: 1001 }, { ...empty, hasDefaultShippingAddress: true },
    { ...empty, hasDefaultBillingAddress: true }, { ...empty, hasDefaultBillingAddress: null },
    { ...empty, schemaVersion: 'v1' },
  ]) assert.equal(validate(value), false);
});
