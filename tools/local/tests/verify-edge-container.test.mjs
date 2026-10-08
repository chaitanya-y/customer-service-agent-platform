import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { stageEdgeBuildContext } from '../verify-edge-container.mjs';

test('Edge Docker context contains only the build inputs', async () => {
  const staged = await stageEdgeBuildContext();
  try {
    assert.ok(staged.fileCount > 10);
    assert.ok(staged.sizeBytes < 2_000_000);
    await access(join(staged.path, 'Dockerfile'));
    await access(join(staged.path, 'apps/services/edge-api/src/bootstrap.ts'));
    await access(join(staged.path, 'packages/refund-policy/releases.json'));
    assert.deepEqual((await readdir(staged.path)).sort(), [
      'Dockerfile', 'apps', 'package.json', 'packages', 'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ]);
    await assert.rejects(access(join(staged.path, 'apps/services/edge-api/.env')));
    await assert.rejects(access(join(staged.path, 'apps/web/storefront')));
    await assert.rejects(access(join(staged.path, '.git')));
  } finally {
    await staged.cleanup();
  }
  await assert.rejects(access(staged.path));
});
