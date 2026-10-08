#!/usr/bin/env node
// Opt-in local packaging audit; no .env loading or business-service startup.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeBuildInput } from './container-proof-safe-input.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const dockerfile = 'infrastructure/images/human-operations/Dockerfile';
const migrations = [
  '001_human_operations.sql', '002_exceptional_refund_decision.sql',
  '003_refund_evidence.sql', '004_decision_outbox_observation_index.sql',
  '005_delivery_issue_reports.sql', '006_delivery_review_closure.sql',
];
const buildInputs = [
  dockerfile, 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'apps/services/human-operations/package.json',
  'apps/services/human-operations/tsconfig.json',
  'packages/observability-node/package.json',
  'packages/observability-node/index.mjs',
  'packages/observability-node/index.d.mts',
  ...migrations.map((name) => `apps/services/human-operations/migrations/${name}`),
];

export async function stageHumanOperationsBuildContext(sourceRepository = repository) {
  const path = await mkdtemp(join(tmpdir(), 'cso-human-operations-proof-context-'));
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
      if (entry.isDirectory()) await stageTypescriptTree(relative);
      else {
        assert.ok(entry.isFile() && entry.name.endsWith('.ts'), `Unexpected Human Operations source entry: ${relative}`);
        await stageFile(relative);
      }
    }
  }
  try {
    await assertSafeBuildInput(sourceRepository, 'apps/services/human-operations/migrations', 'directory');
    const actualMigrations = (await readdir(join(sourceRepository, 'apps/services/human-operations/migrations'))).sort();
    assert.deepEqual(actualMigrations, [...migrations].sort(), 'Human Operations migrations changed; review the image allowlist');
    for (const input of buildInputs) await stageFile(input, input === dockerfile ? 'Dockerfile' : input);
    await stageTypescriptTree('apps/services/human-operations/src');
    assert.ok(sizeBytes < 2_000_000, 'Human Operations context exceeds its reviewed 2 MB limit');
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
    console.log('No Docker resources changed. Run with --run to build and audit Human Operations locally.');
    console.log('The proof does not start the service or contact PostgreSQL, Temporal, Vendure, models, or commerce.');
    return;
  }
  docker(['version'], { quiet: true });
  const staged = await stageHumanOperationsBuildContext();
  const image = `cso-human-operations-proof:${randomBytes(8).toString('hex')}`;
  try {
    console.log(`Staged ${staged.fileCount} reviewed build files (${staged.sizeBytes} bytes).`);
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
      assert.ok(fs.existsSync('dist/bootstrap.js') && fs.existsSync('dist/migrate.js'));
      assert.ok(!fs.existsSync('src') && !fs.existsSync('tests'));
      assert.ok(!fs.existsSync('dist/local-token-cli.js'));
      assert.ok(!fs.existsSync('dist/local-delivery-token-cli.js'));
      assert.ok(!fs.existsSync('dist/local-support-token-cli.js'));
      const migrations = ${JSON.stringify(migrations)};
      assert.deepEqual(fs.readdirSync('migrations').sort(), migrations.sort());
      for (const dependency of ['typescript', 'tsx', '@types/node', '@types/pg']) {
        let found = false; try { import.meta.resolve(dependency); found = true; } catch {}
        assert.ok(!found, 'Development dependency present: ' + dependency);
      }
      for (const dependency of ['fastify', 'jose', 'zod', 'pg', '@temporalio/client', '@cso/observability-node']) {
        await import(dependency);
      }
      const {default: sharp} = await import('sharp');
      const image = await sharp({create:{width:1,height:1,channels:3,background:'#ffffff'}}).png().toBuffer();
      assert.ok(image.length > 0, 'Sharp native image processing failed');
      const forbidden = /^(\\.env(?:\\..*)?|\\.npmrc|\\.git|id_rsa|id_ed25519)$|\\.(?:pem|key|p12|pfx)$/i;
      function walk(directory) {
        for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
          assert.ok(!forbidden.test(entry.name), 'Sensitive path present in image');
          if (entry.isDirectory()) walk(directory + '/' + entry.name);
        }
      }
      walk('/app');
      console.log('Human Operations audit passed: Node 24, non-root, SQL migrations, Sharp, production imports, no dev dependencies or sensitive paths.');
    `;
    docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'node', image, '--input-type=module', '-e', audit]);
    console.log(JSON.stringify({ image, imageId: metadata.Id, sizeBytes: metadata.Size, architecture: metadata.Architecture, audit: 'passed' }, null, 2));
    console.log('Local packaging proof only. Image retained for inspection; no service or business request started.');
  } finally {
    await staged.cleanup();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  verify().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
