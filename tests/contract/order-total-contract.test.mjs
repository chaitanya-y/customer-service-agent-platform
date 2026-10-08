import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

test('order total contract excludes payment, private and uncertain facts', async () => {
  const schema = JSON.parse(await readFile(new URL('../../contracts/tools/order-total/v1/order-total.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const valid = { schemaVersion: '1', reference: 'ORDER-123', total: { amountMinor: 12345, currency: 'USD' } };
  assert.equal(validate(valid), true);
  for (const invalid of [
    { ...valid, payments: [] }, { ...valid, total: { ...valid.total, paid: true } },
    ...[-1, 1.5, true, '12345', 9007199254740992].map(amountMinor => ({ ...valid, total: { ...valid.total, amountMinor } })),
    { ...valid, total: { amountMinor: 1, currency: 'ZZZ' } }, { ...valid, schemaVersion: '2' },
  ]) assert.equal(validate(invalid), false);
});
