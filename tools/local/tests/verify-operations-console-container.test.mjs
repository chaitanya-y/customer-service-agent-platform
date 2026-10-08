import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';

test('Operations Console stages only reviewed source and dependency inputs without local secrets or generated output', async () => {
  const module = await import('../verify-operations-console-container.mjs').catch(() => null);
  assert.ok(module?.stageOperationsConsoleBuildContext, 'Operations Console context staging is missing');
  const staged = await module.stageOperationsConsoleBuildContext();
  try {
    const files = [];
    async function collect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collect(path);
        else { assert.ok(entry.isFile()); files.push(relative(staged.path, path)); }
      }
    }
    await collect(staged.path);
    assert.equal(files.length, staged.fileCount);
    assert.ok(staged.sizeBytes < 2_000_000);
    for (const required of [
      'Dockerfile', 'Dockerfile.dockerignore', 'container-next.config.ts',
      'apps/web/operations-console/package.json', 'apps/web/operations-console/next.config.ts',
      'apps/web/operations-console/tsconfig.json', 'apps/web/operations-console/next-env.d.ts',
      'apps/web/operations-console/app/layout.tsx', 'apps/web/operations-console/app/api/local-session/route.ts',
      'apps/web/operations-console/components/refund-evidence-review.tsx', 'apps/web/operations-console/lib/human-operations-proxy.ts',
      'apps/web/operations-console/lib/delivery-operations-proxy.ts', 'apps/web/operations-console/lib/support-operations-proxy.ts',
      'packages/ui/src/index.tsx', 'packages/ui/src/styles.css',
      'packages/ui/src/refund-evidence-model.ts', 'pnpm-lock.yaml',
    ]) assert.ok(files.includes(required), required);
    assert.ok(files.every((file) => ['Dockerfile', 'Dockerfile.dockerignore', 'container-next.config.ts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(file)
      || /^apps\/web\/operations-console\/(?:package\.json|next\.config\.ts|next-env\.d\.ts|tsconfig\.json|(?:app|components|lib)\/.+\.(?:ts|tsx|css))$/.test(file)
      || /^packages\/ui\/(?:package\.json|src\/.+\.(?:ts|tsx|css))$/.test(file)));
    for (const excluded of ['.git', '.npmrc', 'apps/services', 'apps/web/customer-portal', 'packages/auth', 'apps/web/operations-console/.env', 'apps/web/operations-console/.env.local', 'apps/web/operations-console/.next', 'apps/web/operations-console/node_modules', 'apps/web/operations-console/tests']) {
      await assert.rejects(access(join(staged.path, excluded)));
    }
  } finally { await staged.cleanup(); }
  await assert.rejects(access(staged.path));
});

test('Operations Console proof does nothing without the exact opt-in flag', () => {
  for (const args of [[], ['--help'], ['--run', 'extra']]) {
    const result = spawnSync(process.execPath, [new URL('../verify-operations-console-container.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No Docker resources changed/);
  }
});
