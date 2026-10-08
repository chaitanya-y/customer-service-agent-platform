#!/usr/bin/env node
// Opt-in local packaging audit; never reads .env or sends business requests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeBuildInput } from './container-proof-safe-input.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const dockerfile = 'infrastructure/images/agent-runtime/Dockerfile';
const buildInputs = [
  dockerfile,
  'apps/services/agent-runtime/pyproject.toml',
  'apps/services/agent-runtime/uv.lock',
  'packages/python-observability/pyproject.toml',
  'packages/refund-policy/releases.json',
];

export async function stageAgentRuntimeBuildContext(sourceRepository = repository) {
  const path = await mkdtemp(join(tmpdir(), 'cso-agent-runtime-proof-context-'));
  let fileCount = 0;
  let sizeBytes = 0;
  async function stageFile(sourceRelative, targetRelative = sourceRelative) {
    const source = join(sourceRepository, sourceRelative);
    const metadata = await assertSafeBuildInput(sourceRepository, sourceRelative, 'file');
    assert.ok(metadata.isFile(), `Build input is not a regular file: ${sourceRelative}`);
    const destination = join(path, targetRelative);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    fileCount++;
    sizeBytes += metadata.size;
  }
  async function stagePythonTree(relativeDirectory) {
    await assertSafeBuildInput(sourceRepository, relativeDirectory, 'directory');
    for (const entry of await readdir(join(sourceRepository, relativeDirectory), { withFileTypes: true })) {
      const relative = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') continue;
        await stagePythonTree(relative);
      }
      else {
        assert.ok(entry.isFile() && entry.name.endsWith('.py'), `Unexpected Python source entry: ${relative}`);
        await stageFile(relative);
      }
    }
  }
  try {
    for (const input of buildInputs) await stageFile(input, input === dockerfile ? 'Dockerfile' : input);
    await stagePythonTree('apps/services/agent-runtime/agent_runtime');
    await stagePythonTree('packages/python-observability/cso_observability');
    assert.ok(sizeBytes < 2_000_000, 'Agent Runtime context exceeds its reviewed 2 MB limit');
    return { path, fileCount, sizeBytes, cleanup: () => rm(path, { recursive: true, force: true }) };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

function docker(args, { quiet = false, timeout = 120_000 } = {}) {
  const result = spawnSync('docker', args, {
    cwd: repository, encoding: 'utf8', timeout,
    stdio: quiet ? 'pipe' : 'inherit', maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Docker ${args[0]} failed (${result.status ?? result.error?.code ?? 'unknown'}).`);
  }
  return result.stdout?.trim();
}

async function verify() {
  if (process.argv.length !== 3 || process.argv[2] !== '--run') {
    console.log('No Docker resources changed. Run with --run to build and audit Agent Runtime locally.');
    console.log('The proof uses a private, network-disabled container and makes no model, Gateway, or commerce request.');
    return;
  }
  docker(['version'], { quiet: true });
  const staged = await stageAgentRuntimeBuildContext();
  const image = `cso-agent-runtime-proof:${randomBytes(8).toString('hex')}`;
  try {
    console.log(`Staged ${staged.fileCount} reviewed build files (${staged.sizeBytes} bytes).`);
    docker(['build', '--file', join(staged.path, 'Dockerfile'), '--tag', image, staged.path], { timeout: 600_000 });
    const [metadata] = JSON.parse(docker(['image', 'inspect', image], { quiet: true }));
    assert.equal(metadata.Config.User, 'app');
    assert.deepEqual(metadata.Config.Cmd, ['uvicorn', 'agent_runtime.main:app', '--host', '0.0.0.0', '--port', '8000']);
    // The official Python base publishes GPG_KEY (a public release-signing key).
    // All other credential-shaped environment variable names remain forbidden.
    assert.ok(!metadata.Config.Env.some((value) => {
      const name = value.split('=')[0];
      return name !== 'GPG_KEY' && /SECRET|TOKEN|KEY|PASSWORD/.test(name);
    }));
    const audit = `
import asyncio, importlib.util, json, os, pathlib, sys
assert sys.version_info[:2] == (3, 12)
assert os.getuid() != 0
for name in ('pytest', 'pytest_asyncio', 'ruff'):
    assert importlib.util.find_spec(name) is None, f'dev dependency present: {name}'
from agent_runtime.main import app
from agent_runtime.refund.policy import _default_catalog_path
assert _default_catalog_path() == pathlib.Path('/app/packages/refund-policy/releases.json')
assert _default_catalog_path().is_file()
assert not pathlib.Path('tests').exists()
events = []
async def receive():
    return {'type': 'http.request', 'body': b'', 'more_body': False}
async def send(message):
    events.append(message)
scope = {'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':'GET','scheme':'http',
         'path':'/health','raw_path':b'/health','query_string':b'','root_path':'','headers':[],
         'client':('127.0.0.1',0),'server':('127.0.0.1',8000)}
asyncio.run(app(scope, receive, send))
assert events[0]['status'] == 200
body = b''.join(event.get('body', b'') for event in events if event['type'] == 'http.response.body')
assert json.loads(body) == {'status':'ok','service':'agent-runtime'}
for root, dirs, files in os.walk('/app'):
    for name in dirs + files:
        assert name not in ('.env', '.npmrc', '.git') and not name.startswith('.env.')
print('Agent Runtime offline import and /health audit passed.')
    `;
    docker(['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'python', image, '-c', audit]);
    console.log(JSON.stringify({ image, imageId: metadata.Id, sizeBytes: metadata.Size, architecture: metadata.Architecture, audit: 'passed', hostPortsPublished: false }, null, 2));
    console.log('Local packaging proof only. Image retained for inspection; no service server or business request started.');
  } finally {
    await staged.cleanup();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  verify().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
