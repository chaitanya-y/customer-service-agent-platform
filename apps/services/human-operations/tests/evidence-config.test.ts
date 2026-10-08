import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveEvidenceConfig } from '../src/evidence-config.js';

test('delivery assertion secret alone does not enable photo storage', () => {
  assert.equal(resolveEvidenceConfig(undefined, 'a'.repeat(32)), undefined);
});

test('photo storage requires the existing context assertion secret', () => {
  assert.throws(() => resolveEvidenceConfig('/private/photos', undefined), /INVALID_EVIDENCE_CONFIG/);
  assert.throws(() => resolveEvidenceConfig('/private/photos', 'short'), /INVALID_EVIDENCE_CONFIG/);
  assert.deepEqual(resolveEvidenceConfig('/private/photos', 'a'.repeat(32)), {
    storageDirectory: '/private/photos', contextSecret: 'a'.repeat(32),
  });
});
