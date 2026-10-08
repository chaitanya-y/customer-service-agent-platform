import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { stageHumanOperationsBuildContext } from '../verify-human-operations-container.mjs';

test('Human Operations context includes only source, six migrations, and reviewed manifests', async () => {
  const staged = await stageHumanOperationsBuildContext();
  try {
    const files = [];
    async function collect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collect(path);
        else {
          assert.equal(entry.isFile(), true);
          files.push(relative(staged.path, path));
        }
      }
    }
    await collect(staged.path);
    files.sort();
    assert.equal(staged.fileCount, files.length);
    assert.ok(staged.sizeBytes < 2_000_000);
    assert.deepEqual((await readdir(staged.path)).sort(), [
      'Dockerfile', 'apps', 'package.json', 'packages', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    ]);
    for (const required of [
      'Dockerfile', 'apps/services/human-operations/package.json',
      'apps/services/human-operations/tsconfig.json',
      'apps/services/human-operations/src/bootstrap.ts',
      'apps/services/human-operations/src/migrate.ts',
      'apps/services/human-operations/migrations/001_human_operations.sql',
      'apps/services/human-operations/migrations/006_delivery_review_closure.sql',
      'packages/observability-node/index.mjs',
      'packages/observability-node/index.d.mts',
    ]) assert.ok(files.includes(required), required);
    assert.equal(files.filter((file) => /^apps\/services\/human-operations\/migrations\/.+\.sql$/.test(file)).length, 6);
    assert.ok(files.every((file) => file === 'Dockerfile'
      || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(file)
      || /^apps\/services\/human-operations\/(?:package\.json|tsconfig\.json|src\/.+\.ts|migrations\/[0-9]{3}_[a-z_]+\.sql)$/.test(file)
      || /^packages\/observability-node\/(?:package\.json|index\.mjs|index\.d\.mts)$/.test(file)));
    for (const forbidden of [
      'apps/services/human-operations/.env', 'apps/services/human-operations/node_modules',
      'apps/services/edge-api', 'apps/services/integration-gateway', 'apps/services/conversation-runtime',
      'apps/web', 'packages/refund-policy', '.git', '.npmrc',
    ]) await assert.rejects(access(join(staged.path, forbidden)));
  } finally {
    await staged.cleanup();
  }
  await assert.rejects(access(staged.path));
});

test('Human Operations proof defaults to no Docker action', () => {
  const script = new URL('../verify-human-operations-container.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No Docker resources changed/);
});
