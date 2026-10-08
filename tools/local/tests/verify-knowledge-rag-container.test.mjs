import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';

const script = new URL('../verify-knowledge-rag-container.mjs', import.meta.url);

// Catches broad context copying (secrets, fixture documents, caches or other services).
test('Knowledge/RAG stages only its reviewed source and locked dependencies', async () => {
  await assert.doesNotReject(access(script));
  const { stageKnowledgeRagBuildContext } = await import(script);
  const staged = await stageKnowledgeRagBuildContext();
  try {
    const files = [];
    async function collect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collect(path);
        else files.push(relative(staged.path, path));
      }
    }
    await collect(staged.path);
    assert.equal(files.length, 35);
    assert.equal(staged.fileCount, files.length);
    assert.ok(staged.sizeBytes < 2_000_000);
    for (const required of ['Dockerfile', 'apps/services/knowledge-rag/uv.lock',
      'apps/services/knowledge-rag/pyproject.toml', 'apps/services/knowledge-rag/knowledge_rag/main.py',
      'packages/python-observability/pyproject.toml', 'packages/python-observability/cso_observability/bootstrap.py']) {
      assert.ok(files.includes(required), required);
    }
    assert.ok(files.every((file) => file === 'Dockerfile'
      || ['apps/services/knowledge-rag/pyproject.toml', 'apps/services/knowledge-rag/uv.lock',
        'packages/python-observability/pyproject.toml'].includes(file)
      || /^apps\/services\/knowledge-rag\/knowledge_rag\/[a-z_]+\.py$/.test(file)
      || /^packages\/python-observability\/cso_observability\/[a-z_]+\.py$/.test(file)));
    for (const forbidden of ['.git', '.npmrc', 'apps/services/knowledge-rag/.env',
      'apps/services/knowledge-rag/.venv', 'apps/services/knowledge-rag/tests',
      'apps/services/knowledge-rag/fixtures', 'apps/services/agent-runtime', 'apps/web']) {
      await assert.rejects(access(join(staged.path, forbidden)));
    }
    // Static recipe checks complement the opt-in Docker metadata/runtime audit.
    const recipe = await readFile(join(staged.path, 'Dockerfile'), 'utf8');
    assert.match(recipe, /FROM python:3\.12-slim-bookworm@sha256:[a-f0-9]{64}/);
    assert.match(recipe, /uv==0\.11\.16/);
    assert.match(recipe, /uv sync --frozen --no-dev --no-install-project --no-editable/);
    assert.match(recipe, /HF_HUB_OFFLINE=1/);
    assert.match(recipe, /TRANSFORMERS_OFFLINE=1/);
    assert.match(recipe, /USER app/);
  } finally { await staged.cleanup(); }
  await assert.rejects(access(staged.path));
});

test('Knowledge/RAG image audit requires Hugging Face offline defaults', async () => {
  const { assertKnowledgeRagOfflineDefaults } = await import(script);
  assert.doesNotThrow(() => assertKnowledgeRagOfflineDefaults({
    Config: { Env: ['HF_HUB_OFFLINE=1', 'TRANSFORMERS_OFFLINE=1'] },
  }));
  assert.throws(() => assertKnowledgeRagOfflineDefaults({
    Config: { Env: ['HF_HUB_OFFLINE=0'] },
  }), /HF_HUB_OFFLINE=1/);
  assert.throws(() => assertKnowledgeRagOfflineDefaults({
    Config: { Env: ['HF_HUB_OFFLINE=1'] },
  }), /TRANSFORMERS_OFFLINE=1/);
});

// Catches accidental Docker invocation on default or misspelled arguments.
test('Knowledge/RAG proof is inert unless --run uses only supported options', () => {
  for (const args of [[], ['--help'], ['--run', '--extra']]) {
    const result = spawnSync(process.execPath, [script.pathname, ...args], {
      encoding: 'utf8', env: { PATH: '/nonexistent' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No Docker resources changed/);
  }
});

async function runWithFakeDocker(args) {
  const directory = await mkdtemp(join(tmpdir(), 'cso-rag-fake-docker-'));
  const dockerPath = join(directory, 'docker');
  const callsPath = join(directory, 'calls.jsonl');
  await writeFile(dockerPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_CALLS_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'image' && args[1] === 'inspect') {
  process.stdout.write(JSON.stringify([{ Id: 'sha256:test-image', Size: 1, Architecture: 'amd64',
    Config: { Env: ['HF_HUB_OFFLINE=1', 'TRANSFORMERS_OFFLINE=1'], User: 'app',
      Cmd: ['uvicorn', 'knowledge_rag.main:app', '--host', '0.0.0.0', '--port', '8000'] } }]));
}
`);
  await chmod(dockerPath, 0o700);
  const result = spawnSync(process.execPath, [script.pathname, ...args], {
    encoding: 'utf8',
    env: { PATH: directory, DOCKER_CALLS_LOG: callsPath },
    timeout: 15_000,
  });
  const calls = await readFile(callsPath, 'utf8').then((contents) =>
    contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  ).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  await rm(directory, { recursive: true, force: true });
  return { result, calls };
}

test('Knowledge/RAG --run keeps Docker native platform by default', async () => {
  const { result, calls } = await runWithFakeDocker(['--run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 4, 'only fake Docker commands were issued');
  const build = calls.find((args) => args[0] === 'build');
  const run = calls.find((args) => args[0] === 'run');
  assert.ok(build, 'build command was issued');
  assert.ok(run, 'offline audit container was issued');
  assert.equal(build.includes('--platform'), false);
  assert.equal(run.includes('--platform'), false);
});

test('Knowledge/RAG explicit linux/amd64 opt-in targets build and audit container', async () => {
  const { result, calls } = await runWithFakeDocker(['--run', '--platform', 'linux/amd64']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 4, 'only fake Docker commands were issued');
  const build = calls.find((args) => args[0] === 'build');
  const run = calls.find((args) => args[0] === 'run');
  assert.ok(build, 'build command was issued');
  assert.ok(run, 'offline audit container was issued');
  assert.deepEqual(build.slice(build.indexOf('--platform'), build.indexOf('--platform') + 2),
    ['--platform', 'linux/amd64']);
  assert.deepEqual(run.slice(run.indexOf('--platform'), run.indexOf('--platform') + 2),
    ['--platform', 'linux/amd64']);
  assert.match(run.join(' '), /--network none/);
  assert.match(run.join(' '), /--read-only/);
  assert.match(run.join(' '), /--entrypoint python/);
});

test('Knowledge/RAG invalid or incomplete platform opt-in stays inert', async () => {
  for (const args of [['--run', '--platform', 'linux/arm64'],
    ['--run', '--platform'], ['--platform', 'linux/amd64'], ['--run', '--platform', 'linux/amd64', '--extra']]) {
    const { result, calls } = await runWithFakeDocker(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, []);
    assert.match(result.stdout, /No Docker resources changed/);
  }
});

// Catches following a symlink out of the reviewed source tree.
test('Knowledge/RAG staging refuses symlinked inputs', async () => {
  await assert.doesNotReject(access(script));
  const { stageKnowledgeRagBuildContext } = await import(script);
  const source = await mkdtemp(join(tmpdir(), 'cso-rag-symlink-test-'));
  try {
    const recipe = join(source, 'infrastructure/images/knowledge-rag/Dockerfile');
    await mkdir(dirname(recipe), { recursive: true });
    await symlink(script.pathname, recipe);
    await assert.rejects(stageKnowledgeRagBuildContext({ repositoryRoot: source }), /regular file/);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('Knowledge/RAG staging refuses symlinked parent directories', async () => {
  const { stageKnowledgeRagBuildContext } = await import(script);
  const source = await mkdtemp(join(tmpdir(), 'cso-rag-parent-symlink-test-'));
  try {
    await mkdir(join(source, 'infrastructure/images'), { recursive: true });
    await symlink(new URL('../../../infrastructure/images/knowledge-rag', import.meta.url).pathname,
      join(source, 'infrastructure/images/knowledge-rag'));
    await assert.rejects(stageKnowledgeRagBuildContext({ repositoryRoot: source }), /regular directory/);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('Knowledge/RAG staging refuses a symlinked repository root', async () => {
  const { stageKnowledgeRagBuildContext } = await import(script);
  const source = await mkdtemp(join(tmpdir(), 'cso-rag-root-symlink-test-'));
  try {
    const linkedRoot = join(source, 'linked-repository');
    await symlink(new URL('../../../', import.meta.url).pathname, linkedRoot);
    await assert.rejects(
      stageKnowledgeRagBuildContext({ repositoryRoot: linkedRoot }),
      /regular directory/,
    );
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('Knowledge/RAG staging normalizes a relative repository root without looping', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { stageKnowledgeRagBuildContext } = await import(${JSON.stringify(script.href)});
     const staged = await stageKnowledgeRagBuildContext({ repositoryRoot: '.' });
     await staged.cleanup();`], {
    cwd: new URL('../../../', import.meta.url), encoding: 'utf8', timeout: 2_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
