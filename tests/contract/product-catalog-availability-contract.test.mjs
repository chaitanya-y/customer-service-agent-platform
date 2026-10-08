import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

test('catalog variants accept optional availability but reject counts and unknown stock states', async () => {
  const schema = JSON.parse(await readFile(new URL('../../contracts/tools/product-catalog/v1/product-catalog.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const catalog = variant => ({ schemaVersion: 1, matches: [{ name: 'Travel Mug', description: 'Mug.', variants: [variant] }] });
  for (const availability of ['IN_STOCK', 'OUT_OF_STOCK']) {
    assert.equal(validate(catalog({ name: 'Navy', availability })), true);
  }
  assert.equal(validate(catalog({ name: 'Navy' })), true);
  for (const availability of ['UNKNOWN', null, true, 1]) {
    assert.equal(validate(catalog({ name: 'Navy', availability })), false);
  }
  assert.equal(validate(catalog({ name: 'Navy', stockOnHand: 10 })), false);
  assert.equal(validate(catalog({ name: 'Navy', variantId: 'internal-id' })), false);
  assert.equal(validate({ ...catalog({ name: 'Navy' }), matches: [{ name: 'Travel Mug', description: 'Mug.', variants: [{ name: 'Navy' }], availability: 'IN_STOCK' }] }), true);
});
