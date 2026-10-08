#!/usr/bin/env node
// Opt-in local packaging proof, never a web/service/business smoke test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeBuildInput } from './container-proof-safe-input.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const app = 'apps/web/customer-portal';
const imageDirectory = 'infrastructure/images/customer-portal';
const inputs = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  `${app}/package.json`, `${app}/next.config.ts`, `${app}/tsconfig.json`, `${app}/next-env.d.ts`,
  'packages/auth/package.json', 'packages/ui/package.json',
];
const trees = [`${app}/app`, `${app}/components`, `${app}/lib`, 'packages/auth/src', 'packages/ui/src'];

export async function stageCustomerPortalBuildContext(sourceRepository = repository) {
  const path = await mkdtemp(join(tmpdir(), 'cso-customer-portal-proof-context-'));
  let fileCount = 0;
  let sizeBytes = 0;
  async function stageFile(relative, target = relative) {
    const source = join(sourceRepository, relative);
    const metadata = await assertSafeBuildInput(sourceRepository, relative, 'file');
    assert.ok(metadata.isFile(), `Build input is not a regular file: ${relative}`);
    await mkdir(dirname(join(path, target)), { recursive: true });
    await copyFile(source, join(path, target));
    fileCount++;
    sizeBytes += metadata.size;
  }
  async function stageTree(relative) {
    await assertSafeBuildInput(sourceRepository, relative, 'directory');
    for (const entry of await readdir(join(sourceRepository, relative), { withFileTypes: true })) {
      const child = join(relative, entry.name);
      assert.ok(!entry.name.startsWith('.'), `Unexpected hidden source entry: ${child}`);
      if (entry.isDirectory()) await stageTree(child);
      else {
        assert.ok(entry.isFile() && /\.(?:ts|tsx|css)$/.test(entry.name), `Unreviewed Customer Portal source entry: ${child}`);
        await stageFile(child);
      }
    }
  }
  try {
    await assertSafeBuildInput(sourceRepository, app, 'directory');
    const publicMetadata = await lstat(join(sourceRepository, app, 'public')).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    assert.equal(publicMetadata, null, 'Customer Portal public assets added; review the context and static asset copy first');
    for (const name of ['Dockerfile', 'Dockerfile.dockerignore', 'container-next.config.ts']) {
      await stageFile(`${imageDirectory}/${name}`, name);
    }
    for (const input of inputs) await stageFile(input);
    for (const tree of trees) await stageTree(tree);
    assert.ok(sizeBytes < 2_000_000, 'Customer Portal context exceeds its reviewed 2 MB limit');
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
  if (result.error || result.status !== 0) throw new Error(`Docker ${args[0]} failed (${result.status ?? result.error?.code ?? 'unknown'}).`);
  return result.stdout?.trim();
}

async function verify() {
  if (process.argv.length !== 3 || process.argv[2] !== '--run') {
    console.log('No Docker resources changed. Run with --run to build and audit Customer Portal locally.');
    console.log('Packaging only: no server, HTTP requests, models, services or business actions. Production disables local customer login.');
    return;
  }
  docker(['version'], { quiet: true });
  const staged = await stageCustomerPortalBuildContext();
  const image = `cso-customer-portal-proof:${randomBytes(8).toString('hex')}`;
  try {
    console.log(`Staged ${staged.fileCount} reviewed build files (${staged.sizeBytes} bytes). Dependency downloads require registry access; compilation and audit are offline.`);
    docker(['build', '--file', join(staged.path, 'Dockerfile'), '--tag', image, staged.path], { timeout: 600_000 });
    const [metadata] = JSON.parse(docker(['image', 'inspect', image], { quiet: true }));
    assert.equal(metadata.Config.User, 'node');
    assert.deepEqual(metadata.Config.Cmd, ['node', 'server.js']);
    assert.equal(metadata.Config.WorkingDir, '/app/apps/web/customer-portal');
    assert.ok(metadata.Config.Env.includes('NODE_ENV=production'));
    assert.ok(!metadata.Config.Env.some((value) => /SECRET|TOKEN|KEY|PASSWORD/.test(value.split('=')[0])));
    const audit = `
      const assert = await import('node:assert/strict');
      const fs = await import('node:fs');
      const {createRequire} = await import('node:module');
      const require = createRequire(process.cwd() + '/audit.cjs');
      assert.notEqual(process.getuid(), 0);
      assert.match(process.version, /^v24\\./);
      assert.equal(process.env.NODE_ENV, 'production');
      assert.ok(fs.existsSync('server.js'));
      assert.ok(fs.existsSync('.next/BUILD_ID'));
      assert.ok(fs.existsSync('.next/server/app/api/local-session/route.js'));
      assert.ok(fs.readdirSync('.next/static').length > 0);
      assert.equal(require('next/package.json').version, '16.3.2');
      require('next'); require('next/dist/server/next-server');
      // Standalone traces React and Sharp under Next's pnpm dependency tree,
      // rather than adding root-level application symlinks for them.
      const nextRequire = createRequire(require.resolve('next/package.json'));
      nextRequire('react'); nextRequire('react-dom');
      const sharp = nextRequire('sharp');
      assert.ok((await sharp({create:{width:1,height:1,channels:3,background:'#ffffff'}}).png().toBuffer()).length > 0);
      for (const dependency of ['typescript', '@types/node', '@types/react', '@types/react-dom']) {
        let found = false; try { require.resolve(dependency + '/package.json'); found = true; } catch {}
        assert.ok(!found, 'Development dependency present: ' + dependency);
      }
      for (const path of ['app', 'components', 'lib', 'tests', 'next.config.base.ts', '.next/cache', '/app/apps/services']) {
        assert.ok(!fs.existsSync(path), 'Unneeded build source/output present: ' + path);
      }
      const forbidden = /^(\\.env(?:\\..*)?|\\.npmrc|\\.git|id_rsa|id_ed25519)$|\\.(?:pem|key|p12|pfx)$/i;
      function walk(directory) {
        for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
          assert.ok(!forbidden.test(entry.name), 'Sensitive path present in image');
          if (entry.isDirectory()) walk(directory + '/' + entry.name);
        }
      }
      walk('/app');
      console.log('Customer Portal audit passed: non-root Node 24, Next runtime imports, Sharp, compiled routes and static assets, no dev dependencies or sensitive paths.');
    `;
    docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'node', image, '--input-type=module', '-e', audit]);
    console.log(JSON.stringify({ image, imageId: metadata.Id, sizeBytes: metadata.Size, architecture: metadata.Architecture, audit: 'passed' }, null, 2));
    console.log('Local packaging proof only. Image retained; server never started. Local login is disabled in production; no authenticated journey was verified.');
  } finally { await staged.cleanup(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  verify().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
