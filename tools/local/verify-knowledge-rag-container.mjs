#!/usr/bin/env node
// Opt-in packaging audit only. Never reads .env, runs lifespan or queries RAG.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const dockerfile = 'infrastructure/images/knowledge-rag/Dockerfile';
// Explicit filenames: newly added files require review before joining the context.
const ragSources = [
  '__init__', 'api', 'chunking', 'config', 'customer_evidence', 'docx_parser',
  'embeddings', 'evaluation', 'evaluation_runner', 'hybrid_retrieval',
  'index_documents', 'ingestion', 'local_tenant_publication', 'main', 'models',
  'observability', 'opensearch_indexing', 'opensearch_local',
  'opensearch_retrieval', 'opensearch_schema', 'parsers', 'pdf_parser',
  'registered_ingestion', 'release_ingestion', 'reranking', 'retrieval_results',
  'retrieval_service', 'source_registry', 'trusted_context',
];
const buildInputs = [
  dockerfile,
  'apps/services/knowledge-rag/pyproject.toml',
  'apps/services/knowledge-rag/uv.lock',
  'packages/python-observability/pyproject.toml',
  'packages/python-observability/cso_observability/__init__.py',
  'packages/python-observability/cso_observability/bootstrap.py',
  ...ragSources.map((name) => `apps/services/knowledge-rag/knowledge_rag/${name}.py`),
];

export async function stageKnowledgeRagBuildContext({ repositoryRoot = repository } = {}) {
  repositoryRoot = resolve(repositoryRoot);
  assert.ok((await lstat(repositoryRoot)).isDirectory(), 'Repository root is not a regular directory');
  const path = await mkdtemp(join(tmpdir(), 'cso-knowledge-rag-proof-context-'));
  let fileCount = 0;
  let sizeBytes = 0;
  try {
    for (const relative of buildInputs) {
      const source = join(repositoryRoot, relative);
      const metadata = await lstat(source);
      assert.ok(metadata.isFile(), `Build input is not a regular file: ${relative}`);
      let ancestor = dirname(source);
      while (ancestor !== resolve(repositoryRoot)) {
        assert.ok((await lstat(ancestor)).isDirectory(), `Build input parent is not a regular directory: ${relative}`);
        ancestor = dirname(ancestor);
      }
      const destination = join(path, relative === dockerfile ? 'Dockerfile' : relative);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      fileCount++;
      sizeBytes += metadata.size;
    }
    assert.ok(sizeBytes < 2_000_000, 'Knowledge/RAG context exceeds its reviewed 2 MB limit');
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

export function assertKnowledgeRagOfflineDefaults(metadata) {
  const imageEnvironment = new Map((metadata.Config?.Env ?? []).map((entry) => {
    const separator = entry.indexOf('=');
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  assert.equal(imageEnvironment.get('HF_HUB_OFFLINE'), '1', 'Image must set HF_HUB_OFFLINE=1');
  assert.equal(imageEnvironment.get('TRANSFORMERS_OFFLINE'), '1', 'Image must set TRANSFORMERS_OFFLINE=1');
}

function parseVerifyOptions(arguments_) {
  let run = false;
  let platform;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--run' && !run) {
      run = true;
      continue;
    }
    if (argument === '--platform' && platform === undefined
      && arguments_[index + 1] === 'linux/amd64') {
      platform = arguments_[++index];
      continue;
    }
    return undefined;
  }
  return run ? { platform } : undefined;
}

async function verify(arguments_ = process.argv.slice(2)) {
  const options = parseVerifyOptions(arguments_);
  if (!options) {
    console.log('No Docker resources changed. Run with --run to build and audit Knowledge/RAG locally.');
    console.log('Offline import and /health only; no lifespan, model download, indexing or OpenSearch request.');
    return;
  }
  docker(['version'], { quiet: true });
  const staged = await stageKnowledgeRagBuildContext();
  const image = `cso-knowledge-rag-proof:${randomBytes(8).toString('hex')}`;
  try {
    console.log(`Staged ${staged.fileCount} reviewed build files (${staged.sizeBytes} bytes).`);
    console.log('Build downloads locked dependencies; Linux ML dependencies may be large. No model weights are downloaded.');
    const buildArguments = ['build'];
    if (options.platform) buildArguments.push('--platform', options.platform);
    buildArguments.push('--file', join(staged.path, 'Dockerfile'), '--tag', image, staged.path);
    docker(buildArguments, { timeout: 1_200_000 });
    const [metadata] = JSON.parse(docker(['image', 'inspect', image], { quiet: true }));
    assertKnowledgeRagOfflineDefaults(metadata);
    if (options.platform) {
      assert.equal(metadata.Architecture, 'amd64', 'Requested linux/amd64 image must be x86_64');
    }
    assert.equal(metadata.Config.User, 'app');
    assert.deepEqual(metadata.Config.Cmd, ['uvicorn', 'knowledge_rag.main:app', '--host', '0.0.0.0', '--port', '8000']);
    // Official Python's GPG_KEY is a public release-signing key, not a secret.
    assert.ok(!metadata.Config.Env.some((value) => {
      const name = value.split('=')[0];
      return name !== 'GPG_KEY' && /SECRET|TOKEN|KEY|PASSWORD/i.test(name);
    }));
    const audit = `
import asyncio, importlib.util, json, os, pathlib, sys
assert sys.version_info[:2] == (3, 12)
assert os.getuid() != 0
for name in ('pytest', 'ruff'):
    assert importlib.util.find_spec(name) is None, f'dev dependency present: {name}'
# Dependency imports only: never instantiate a model or construct a client.
import bs4, docx, jwt, openai, opensearchpy, pypdf, tiktoken
from sentence_transformers import CrossEncoder
from knowledge_rag.main import app
assert not pathlib.Path('tests').exists()
assert not pathlib.Path('fixtures').exists()
events = []
async def receive():
    return {'type': 'http.request', 'body': b'', 'more_body': False}
async def send(message):
    events.append(message)
# Deliberately HTTP-only: ASGI lifespan warms the real configured retriever.
scope = {'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':'GET','scheme':'http',
         'path':'/health','raw_path':b'/health','query_string':b'','root_path':'','headers':[],
         'client':('127.0.0.1',0),'server':('127.0.0.1',8000)}
asyncio.run(app(scope, receive, send))
assert events[0]['status'] == 200
body = b''.join(event.get('body', b'') for event in events if event['type'] == 'http.response.body')
assert json.loads(body) == {'status':'ok','service':'knowledge-rag'}
for root, dirs, files in os.walk('/app'):
    for name in dirs + files:
        assert not name.startswith('.env') and name not in ('.npmrc', '.git')
print('Knowledge/RAG offline imports and /health audit passed (lifespan intentionally not run).')
    `;
    const runArguments = ['run'];
    if (options.platform) runArguments.push('--platform', options.platform);
    runArguments.push('--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--entrypoint', 'python', image, '-c', audit);
    docker(runArguments);
    console.log(JSON.stringify({ image, imageId: metadata.Id, sizeBytes: metadata.Size,
      architecture: metadata.Architecture, requestedPlatform: options.platform ?? null,
      audit: 'passed', lifespanRun: false, hostPortsPublished: false }, null, 2));
    console.log('Local packaging proof only. Image retained; no service server or business request started.');
  } finally { await staged.cleanup(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  verify().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
