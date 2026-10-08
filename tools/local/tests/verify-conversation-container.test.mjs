import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { stageConversationBuildContext } from '../verify-conversation-container.mjs';

test('Conversation Runtime context includes only reviewed files and cleans up', async () => {
  const staged = await stageConversationBuildContext();
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
      'Dockerfile', 'apps/services/conversation-runtime/package.json',
      'apps/services/conversation-runtime/tsconfig.json',
      'apps/services/conversation-runtime/src/bootstrap.ts',
      'packages/observability-node/index.mjs',
      'packages/observability-node/index.d.mts',
    ]) assert.ok(files.includes(required), required);
    assert.ok(files.every((file) => file === 'Dockerfile'
      || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(file)
      || /^apps\/services\/conversation-runtime\/(?:package\.json|tsconfig\.json|src\/.+\.ts)$/.test(file)
      || /^packages\/observability-node\/(?:package\.json|index\.mjs|index\.d\.mts)$/.test(file)));
    for (const forbidden of [
      'apps/services/conversation-runtime/.env', 'apps/services/conversation-runtime/node_modules',
      'apps/services/edge-api', 'apps/services/integration-gateway', 'apps/web',
      'packages/refund-policy', '.git', '.npmrc',
    ]) await assert.rejects(access(join(staged.path, forbidden)));
  } finally {
    await staged.cleanup();
  }
  await assert.rejects(access(staged.path));
});

test('Conversation Runtime proof defaults to no Docker action', () => {
  const script = new URL('../verify-conversation-container.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No Docker resources changed/);
});
