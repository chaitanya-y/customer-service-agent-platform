import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';

test('Customer Portal stages only reviewed source and dependency inputs without local secrets or generated output', async () => {
  const module = await import('../verify-customer-portal-container.mjs').catch(() => null);
  assert.ok(module?.stageCustomerPortalBuildContext, 'Customer Portal context staging is missing');
  const staged = await module.stageCustomerPortalBuildContext();
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
      'apps/web/customer-portal/package.json', 'apps/web/customer-portal/next.config.ts',
      'apps/web/customer-portal/tsconfig.json', 'apps/web/customer-portal/next-env.d.ts',
      'apps/web/customer-portal/app/layout.tsx', 'apps/web/customer-portal/app/api/local-session/route.ts',
      'apps/web/customer-portal/components/refund-evidence.tsx', 'apps/web/customer-portal/lib/refund-proxy.ts',
      'packages/auth/src/index.ts', 'packages/ui/src/index.tsx', 'packages/ui/src/styles.css',
      'packages/ui/src/refund-evidence-model.ts', 'pnpm-lock.yaml',
    ]) assert.ok(files.includes(required), required);
    assert.ok(files.every((file) => ['Dockerfile', 'Dockerfile.dockerignore', 'container-next.config.ts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(file)
      || /^apps\/web\/customer-portal\/(?:package\.json|next\.config\.ts|next-env\.d\.ts|tsconfig\.json|(?:app|components|lib)\/.+\.(?:ts|tsx|css))$/.test(file)
      || /^packages\/(?:auth|ui)\/(?:package\.json|src\/.+\.(?:ts|tsx|css))$/.test(file)));
    for (const excluded of ['.git', '.npmrc', 'apps/services', 'apps/web/operations-console', 'apps/web/customer-portal/.env', 'apps/web/customer-portal/.env.local', 'apps/web/customer-portal/.next', 'apps/web/customer-portal/node_modules', 'apps/web/customer-portal/tests']) {
      await assert.rejects(access(join(staged.path, excluded)));
    }
  } finally { await staged.cleanup(); }
  await assert.rejects(access(staged.path));
});

test('Customer Portal proof does nothing without the exact opt-in flag', () => {
  for (const args of [[], ['--help'], ['--run', 'extra']]) {
    const result = spawnSync(process.execPath, [new URL('../verify-customer-portal-container.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No Docker resources changed/);
  }
});
