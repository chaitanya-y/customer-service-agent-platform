import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { stageAgentRuntimeBuildContext } from '../verify-agent-runtime-container.mjs';

test('Agent Runtime context contains only reviewed Python inputs and policy catalog', async () => {
  const staged = await stageAgentRuntimeBuildContext();
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
    assert.deepEqual((await readdir(staged.path)).sort(), ['Dockerfile', 'apps', 'packages']);
    for (const required of [
      'Dockerfile', 'apps/services/agent-runtime/pyproject.toml',
      'apps/services/agent-runtime/uv.lock',
      'apps/services/agent-runtime/agent_runtime/main.py',
      'packages/python-observability/pyproject.toml',
      'packages/python-observability/cso_observability/bootstrap.py',
      'packages/refund-policy/releases.json',
    ]) assert.ok(files.includes(required), required);
    assert.ok(files.every((file) => file === 'Dockerfile'
      || ['apps/services/agent-runtime/pyproject.toml', 'apps/services/agent-runtime/uv.lock',
        'packages/python-observability/pyproject.toml', 'packages/refund-policy/releases.json'].includes(file)
      || /^apps\/services\/agent-runtime\/agent_runtime\/.+\.py$/.test(file)
      || /^packages\/python-observability\/cso_observability\/.+\.py$/.test(file)));
    for (const forbidden of [
      'apps/services/agent-runtime/.env', 'apps/services/agent-runtime/.venv',
      'apps/services/agent-runtime/tests', 'apps/services/edge-api',
      'apps/services/integration-gateway', 'apps/services/conversation-runtime',
      'apps/web', 'packages/refund-policy/index.mjs', '.git', '.npmrc',
    ]) await assert.rejects(access(join(staged.path, forbidden)));
    const dockerfile = await readFile(join(staged.path, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /FROM python:3\.12-slim-bookworm@sha256:[a-f0-9]{64}/);
    assert.match(dockerfile, /uv sync --frozen --no-dev --no-install-project --no-editable/);
    assert.match(dockerfile, /USER app/);
  } finally {
    await staged.cleanup();
  }
  await assert.rejects(access(staged.path));
});

test('Agent Runtime proof defaults to no Docker action', () => {
  const script = new URL('../verify-agent-runtime-container.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No Docker resources changed/);
});
