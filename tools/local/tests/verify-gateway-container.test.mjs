import assert from 'node:assert/strict';
import { access, lstat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { stageGatewayBuildContext } from '../verify-gateway-container.mjs';

test('Gateway Docker context stages only reviewed build inputs', async () => {
  const staged = await stageGatewayBuildContext();
  try {
    const files = [];
    async function collect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        assert.equal(entry.isSymbolicLink(), false);
        if (entry.isDirectory()) await collect(path);
        else {
          assert.equal(entry.isFile(), true);
          files.push(relative(staged.path, path));
        }
      }
    }
    await collect(staged.path);
    files.sort();
    assert.ok(staged.fileCount > 10);
    assert.ok(staged.sizeBytes < 2_000_000);
    assert.deepEqual((await readdir(staged.path)).sort(), [
      'Dockerfile', 'apps', 'package.json', 'packages', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    ]);
    assert.ok(files.includes('apps/services/integration-gateway/src/bootstrap.ts'));
    assert.ok(files.includes('packages/observability-node/index.mjs'));
    assert.ok(files.includes('packages/observability-node/index.d.mts'));
    assert.ok(files.every((file) => file === 'Dockerfile'
      || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(file)
      || /^apps\/services\/integration-gateway\/(?:package\.json|tsconfig\.json|src\/.+\.ts)$/.test(file)
      || /^packages\/observability-node\/(?:package\.json|index\.mjs|index\.d\.mts)$/.test(file)));
    assert.ok(files.every((file) => !/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|node_modules|\.git)(?:\/|$)/.test(file)));
    for (const forbidden of [
      'apps/services/edge-api', 'apps/web', 'apps/services/integration-gateway/.env',
      'apps/services/integration-gateway/node_modules', 'packages/refund-policy', '.git',
    ]) await assert.rejects(access(join(staged.path, forbidden)));
    assert.equal((await lstat(join(staged.path, 'Dockerfile'))).isFile(), true);
  } finally {
    await staged.cleanup();
  }
  await assert.rejects(access(staged.path));
});
