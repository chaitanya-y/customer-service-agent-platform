import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { resolveWorkflowsPath } from '../src/refund-worker.js';

test('compiled worker resolves the emitted JavaScript workflow entrypoint', () => {
  const compiledWorker = pathToFileURL('/opt/app/dist/refund-worker.js');
  assert.equal(resolveWorkflowsPath(compiledWorker.href), '/opt/app/dist/workflows.js');
});

test('development worker resolves the TypeScript workflow entrypoint', () => {
  const sourceWorker = pathToFileURL('/opt/app/src/refund-worker.ts');
  assert.equal(resolveWorkflowsPath(sourceWorker.href), '/opt/app/src/workflows.ts');
});
