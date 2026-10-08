import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { stageWorkflowBuildContext } from '../verify-workflow-container.mjs';

test('Workflow Worker context stages only runtime and build inputs', async () => {
  const staged = await stageWorkflowBuildContext();
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
    assert.equal(files.length, staged.fileCount);
    assert.ok(staged.sizeBytes < 2_000_000);
    for (const required of [
      'Dockerfile', 'apps/services/workflow-workers/package.json',
      'apps/services/workflow-workers/tsconfig.json',
      'apps/services/workflow-workers/src/server.ts',
      'apps/services/workflow-workers/src/workflows.ts',
      'packages/observability-node/index.mjs',
      'packages/refund-policy/index.mjs', 'packages/refund-policy/releases.json',
    ]) assert.ok(files.includes(required), required);
    assert.ok(files.every((file) => file === 'Dockerfile'
      || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(file)
      || /^apps\/services\/workflow-workers\/(?:package\.json|tsconfig\.json|src\/.+\.ts)$/.test(file)
      || /^packages\/observability-node\/(?:package\.json|index\.mjs|index\.d\.mts)$/.test(file)
      || /^packages\/refund-policy\/(?:index\.mjs|index\.d\.mts|releases\.json)$/.test(file)));
    for (const forbidden of [
      'apps/services/workflow-workers/.env', 'apps/services/workflow-workers/node_modules',
      'apps/services/edge-api', 'apps/services/integration-gateway', 'apps/web', '.git', '.npmrc',
    ]) await assert.rejects(access(join(staged.path, forbidden)));
  } finally {
    await staged.cleanup();
  }
  await assert.rejects(access(staged.path));
});

test('Workflow Worker proof defaults to no Docker action', () => {
  const script = new URL('../verify-workflow-container.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No Docker resources changed/);
});
