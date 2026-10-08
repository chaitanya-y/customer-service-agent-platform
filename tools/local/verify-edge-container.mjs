#!/usr/bin/env node
// Explicitly local Docker Desktop proof; never loads repository .env files.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeBuildInput } from './container-proof-safe-input.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const dockerfile = 'infrastructure/images/edge-api/Dockerfile';
const buildInputs = [
  dockerfile,
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'apps/services/edge-api/package.json',
  'apps/services/edge-api/tsconfig.json',
  'packages/observability-node/package.json',
  'packages/observability-node/index.mjs',
  'packages/observability-node/index.d.mts',
  'packages/refund-policy/index.mjs',
  'packages/refund-policy/index.d.mts',
  'packages/refund-policy/releases.json',
];

export async function stageEdgeBuildContext(sourceRepository = repository) {
  const path = await mkdtemp(join(tmpdir(), 'cso-edge-proof-context-'));
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
  async function stageTypescriptTree(relativeDirectory) {
    await assertSafeBuildInput(sourceRepository, relativeDirectory, 'directory');
    for (const entry of await readdir(join(sourceRepository, relativeDirectory), { withFileTypes: true })) {
      const relative = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await stageTypescriptTree(relative);
      } else {
        assert.ok(entry.isFile() && entry.name.endsWith('.ts'), `Unexpected Edge source entry: ${relative}`);
        await stageFile(relative);
      }
    }
  }
  try {
    for (const input of buildInputs) {
      await stageFile(input, input === dockerfile ? 'Dockerfile' : input);
    }
    await stageTypescriptTree('apps/services/edge-api/src');
    assert.ok(sizeBytes < 2_000_000, 'Edge context exceeds its reviewed 2 MB limit');
    return {
      path, fileCount, sizeBytes,
      cleanup: () => rm(path, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

function docker(args, { quiet = false, timeout = 120_000 } = {}) {
  const result = spawnSync('docker', args, {
    cwd: repository,
    encoding: 'utf8',
    timeout,
    stdio: quiet ? 'pipe' : 'inherit',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // Do not print arguments: runtime environment includes throwaway signing keys.
    throw new Error(`Docker ${args[0]} failed (${result.status ?? result.error?.code ?? 'unknown'}).`);
  }
  return result.stdout?.trim();
}

async function verify() {
  if (process.argv.length !== 3 || process.argv[2] !== '--run') {
    console.log('No Docker resources changed. Run with --run to build and smoke-test Edge locally.');
    console.log('Requires Docker Desktop for Mac and a healthy local Temporal at host.docker.internal:7233.');
    return;
  }
  docker(['version'], { quiet: true });
  const staged = await stageEdgeBuildContext();
  console.log(`Staged ${staged.fileCount} reviewed build files (${staged.sizeBytes} bytes).`);
  const suffix = randomBytes(8).toString('hex');
  const image = `cso-edge-proof:${suffix}`;
  const network = `cso-edge-proof-${suffix}`;
  const container = `cso-edge-proof-${suffix}`;
  const port = randomInt(20_000, 60_000);
  let networkCreated = false;
  let containerCreated = false;
  try {
    docker(['build', '--file', join(staged.path, 'Dockerfile'), '--tag', image, staged.path], { timeout: 600_000 });
    const [metadata] = JSON.parse(docker(['image', 'inspect', image], { quiet: true }));
    assert.equal(metadata.Config.User, 'node');
    assert.deepEqual(metadata.Config.Cmd, ['node', 'dist/bootstrap.js']);
    assert.ok(!metadata.Config.Env.some((value) => /SECRET|TOKEN|KEY|PASSWORD/.test(value.split('=')[0])));
    const audit = `
      const assert = await import('node:assert/strict');
      const fs = await import('node:fs');
      assert.notEqual(process.getuid(), 0);
      assert.match(process.version, /^v24\\./);
      assert.ok(fs.existsSync('dist/bootstrap.js'));
      assert.ok(!fs.existsSync('src') && !fs.existsSync('tests'));
      for (const dependency of ['typescript', 'tsx', '@types/node']) {
        let found = false; try { import.meta.resolve(dependency); found = true; } catch {}
        assert.ok(!found, 'Development dependency present: ' + dependency);
      }
      for (const dependency of ['fastify', 'jose', 'zod', '@temporalio/client', '@cso/observability-node']) {
        await import(dependency);
      }
      const policy = await import('../../../packages/refund-policy/index.mjs');
      assert.equal(policy.getRefundPolicyBinding('refund-policy-v1').policyVersion, 'refund-policy-v1');
      const forbidden = /^(\\.env(?:\\..*)?|\\.npmrc|\\.git|id_rsa|id_ed25519)$|\\.(?:pem|key|p12|pfx)$/i;
      function walk(directory) {
        for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
          assert.ok(!forbidden.test(entry.name), 'Sensitive path present in image');
          if (entry.isDirectory()) walk(directory + '/' + entry.name);
        }
      }
      walk('/app');
      console.log('Runtime audit passed: Node 24, non-root, runtime imports, policy catalog, no dev dependencies or sensitive paths.');
    `;
    docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'node', image, '--input-type=module', '-e', audit]);
    docker(['network', 'create', network], { quiet: true });
    networkCreated = true;
    const runtime = {
      NODE_ENV: 'test', HOST: '0.0.0.0', PORT: String(port),
      TENANT_ID: 'container-proof', ENVIRONMENT_ID: 'container-proof',
      TEMPORAL_ADDRESS: 'host.docker.internal:7233',
      CSO_TELEMETRY_ENABLED: 'false',
      LOCAL_AUTH_HMAC_SECRET: randomBytes(32).toString('hex'),
      CONTEXT_ASSERTION_HMAC_SECRET: randomBytes(32).toString('hex'),
      EDGE_SERVICE_ASSERTION_HMAC_SECRET: randomBytes(32).toString('hex'),
    };
    const environment = Object.entries(runtime).flatMap(([name, value]) => ['--env', `${name}=${value}`]);
    docker(['create', '--name', container, '--network', network, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...environment, image], { quiet: true });
    containerCreated = true;
    docker(['start', container], { quiet: true });
    const health = `
      const assert = await import('node:assert/strict');
      let lastError;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          const response = await fetch('http://127.0.0.1:${port}/health', {signal:AbortSignal.timeout(1000)});
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), {service:'edge-api',status:'ok'});
          console.log('Default Edge entrypoint /health passed on private ephemeral port ${port}.');
          process.exit(0);
        } catch (error) { lastError = error; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('Private Edge health smoke failed; check local Temporal availability.', {cause:lastError});
    `;
    docker(['exec', container, 'node', '--input-type=module', '-e', health], { timeout: 40_000 });
    const [running] = JSON.parse(docker(['inspect', container], { quiet: true }));
    assert.equal(running.State.Running, true);
    assert.deepEqual(running.HostConfig.PortBindings, {});
    docker(['stop', '--time', '10', container], { quiet: true, timeout: 20_000 });
    const [stopped] = JSON.parse(docker(['inspect', container], { quiet: true }));
    assert.equal(stopped.State.ExitCode, 0, 'Edge must shut down cleanly on SIGTERM');
    console.log(JSON.stringify({ image, imageId: metadata.Id, sizeBytes: metadata.Size, architecture: metadata.Architecture, hostPortsPublished: false, health: 'passed', shutdown: 'passed' }, null, 2));
    console.log('Local packaging proof only: uses host Temporal, local auth, no business requests, no AWS/production readiness claim. Image retained for inspection.');
  } finally {
    try {
      if (containerCreated) docker(['rm', '--force', container], { quiet: true });
      if (networkCreated) docker(['network', 'rm', network], { quiet: true });
    } finally {
      await staged.cleanup();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  verify().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
