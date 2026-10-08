import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

test('recent references contract bounds the list and excludes personal/provider data', async () => {
  const schema = JSON.parse(await readFile(new URL('../../contracts/tools/recent-order-references/v1/recent-order-references.schema.json', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
  const validate = ajv.compile(schema);
  const empty = { schemaVersion: '1', orders: [], hasMore: false };
  const item = { reference: 'ABC-42', placedAt: '2026-10-01T12:00:00.000Z' };
  assert.equal(validate(empty), true);
  assert.equal(validate({ ...empty, orders: [item] }), true);
  assert.equal(validate({ ...empty, orders: [{ ...item, placedAt: '2026-10-01T12:00:00-05:00' }] }), true);
  for (const value of [{ ...empty, customerId: 'private' }, { ...empty, schemaVersion: 'v1' }, { ...empty, hasMore: true }, { ...empty, hasMore: 'false' }, { ...empty, orders: Array(11).fill(item) }, { ...empty, orders: [{ ...item, address: 'private' }] }, { ...empty, orders: [{ ...item, reference: ' ' }] }, { ...empty, orders: [{ ...item, reference: 'x'.repeat(101) }] }, { ...empty, orders: [{ ...item, placedAt: '2026-02-30T12:00:00Z' }] }, { ...empty, orders: [{ ...item, placedAt: '2026-10-01' }] }]) assert.equal(validate(value), false, JSON.stringify(value));
});
