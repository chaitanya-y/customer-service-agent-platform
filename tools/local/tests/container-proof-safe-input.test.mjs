import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cso-safe-input-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'safe.ts'), 'export const safe = true;');
  return root;
}

async function guard() {
  const module = await import('../container-proof-safe-input.mjs').catch(() => null);
  assert.ok(module?.assertSafeBuildInput, 'Build-input ancestry guard is missing');
  return module.assertSafeBuildInput;
}

test('guard accepts regular files and directories inside the reviewed root', async (t) => {
  const root = await fixture(t);
  const validate = await guard();
  assert.ok((await validate(root, 'src/safe.ts', 'file')).isFile());
  assert.ok((await validate(root, 'src', 'directory')).isDirectory());
});

test('guard rejects a symlinked root, ancestor directory, and leaf file', async (t) => {
  const root = await fixture(t);
  const validate = await guard();
  await symlink(join(root, 'src'), join(root, 'linked-src'));
  await symlink(join(root, 'src', 'safe.ts'), join(root, 'src', 'linked.ts'));
  await symlink(root, join(root, 'linked-root'));
  for (const [base, relative] of [[root, 'linked-src/safe.ts'], [root, 'src/linked.ts'], [join(root, 'linked-root'), 'src/safe.ts']]) {
    await assert.rejects(validate(base, relative, 'file'), /symbolic link/i);
  }
});

test('guard rejects hidden source files, hidden directories, and sensitive names', async (t) => {
  const root = await fixture(t);
  const validate = await guard();
  await mkdir(join(root, 'src', '.hidden'));
  await writeFile(join(root, 'src', '.hidden', 'safe.ts'), 'private');
  for (const name of ['.env.secret.ts', '.env.secret.py', '.npmrc', 'id_rsa', 'ID_ED25519', 'client.pem', 'client.KEY', 'client.p12', 'client.pfx']) {
    await writeFile(join(root, 'src', name), 'private');
    await assert.rejects(validate(root, 'src/' + name, 'file'), /hidden|sensitive/i);
  }
  await assert.rejects(validate(root, 'src/.hidden/safe.ts', 'file'), /hidden|sensitive/i);
});

test('guard rejects escapes, ambiguous paths, and nonmatching file types', async (t) => {
  const root = await fixture(t);
  const validate = await guard();
  for (const path of ['../safe.ts', 'src/../safe.ts', '/tmp/safe.ts', '', 'src//safe.ts', 'src/./safe.ts', 'src\\safe.ts']) {
    await assert.rejects(validate(root, path, 'file'), /relative|component|path/i);
  }
  await assert.rejects(validate(root, 'src', 'file'), /regular file/i);
  await assert.rejects(validate(root, 'src/safe.ts', 'directory'), /directory/i);
  await assert.rejects(validate(root, 'src/safe.ts', 'other'), /expected type/i);
});

const proofs = [
  ['edge', 'stageEdgeBuildContext', 'edge-api', 'apps/services/edge-api/src', 'ts'],
  ['gateway', 'stageGatewayBuildContext', 'integration-gateway', 'apps/services/integration-gateway/src', 'ts'],
  ['conversation', 'stageConversationBuildContext', 'conversation-runtime', 'apps/services/conversation-runtime/src', 'ts'],
  ['workflow', 'stageWorkflowBuildContext', 'workflow-workers', 'apps/services/workflow-workers/src', 'ts'],
  ['human-operations', 'stageHumanOperationsBuildContext', 'human-operations', 'apps/services/human-operations/src', 'ts'],
  ['agent-runtime', 'stageAgentRuntimeBuildContext', 'agent-runtime', 'apps/services/agent-runtime/agent_runtime', 'py'],
  ['customer-portal', 'stageCustomerPortalBuildContext', 'customer-portal', 'apps/web/customer-portal/app', 'tsx'],
  ['operations-console', 'stageOperationsConsoleBuildContext', 'operations-console', 'apps/web/operations-console/app', 'tsx'],
  ['admin-console', 'stageAdminConsoleBuildContext', 'admin-console', 'apps/web/admin-console/app', 'tsx'],
];

for (const [name, exportedName, image, tree, extension] of proofs) {
  test(`${name} staging rejects hidden files, hidden source directories, and symlinked ancestors in disposable roots`, async (t) => {
    const stage = (await import(`../verify-${name}-container.mjs`))[exportedName];
    const baseline = await stage();
    t.after(() => baseline.cleanup());
    for (const mutation of ['hidden-file', 'hidden-directory', 'linked-ancestor']) {
      const root = await mkdtemp(join(tmpdir(), 'cso-proof-fixture-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      await cp(baseline.path, root, { recursive: true });
      const imagePath = join(root, 'infrastructure', 'images', image);
      await mkdir(imagePath, { recursive: true });
      await copyFile(join(root, 'Dockerfile'), join(imagePath, 'Dockerfile'));
      if (tree.startsWith('apps/web')) {
        for (const file of ['Dockerfile.dockerignore', 'container-next.config.ts']) await copyFile(join(root, file), join(imagePath, file));
      }
      if (mutation === 'hidden-file') await writeFile(join(root, tree, `.env.secret.${extension}`), 'sensitive fixture');
      else if (mutation === 'hidden-directory') {
        await mkdir(join(root, tree, '.hidden'));
        await writeFile(join(root, tree, '.hidden', `private.${extension}`), 'sensitive fixture');
      } else {
        // The final source file remains regular; only an ancestor becomes a link.
        await rename(join(root, 'apps'), join(root, 'actual-apps'));
        await symlink(join(root, 'actual-apps'), join(root, 'apps'));
      }
      await assert.rejects(async () => {
        const staged = await stage(root);
        await staged.cleanup();
      }, /hidden|sensitive|symbolic link/i, mutation);
    }
  });
}
