import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Pool } from 'pg';

import { PostgresRefundExecutionRepository } from '../../src/refund-execution-repository.js';

const databaseUrl = process.env.CSO_REFUND_CLAIM_TEST_DATABASE_URL;

test('real PostgreSQL serializes distinct refund workflows for one order', {
  skip: databaseUrl === undefined ? 'requires an isolated claim-test database' : undefined,
}, async () => {
  if (!databaseUrl) return;
  const url = new URL(databaseUrl);
  assert.match(url.pathname, /^\/cso_refund_claim_check_/);

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const orderId = `claim-test-${randomUUID()}`;
    const input = {
      tenantId: 'claim-test-tenant',
      environmentId: 'claim-test-environment',
      orderId,
      workflowId: `workflow-${randomUUID()}`,
      previewId: `preview-${randomUUID()}`,
      idempotencyKey: `refund-${randomUUID()}`,
      amountMinor: 100,
      currency: 'USD',
      selection: { scope: 'SELECTED_ITEMS' as const, itemIds: ['line-1'] },
      reasonCode: 'DAMAGED',
      occurredAt: new Date().toISOString(),
    };
    const other = {
      ...input,
      workflowId: `workflow-${randomUUID()}`,
      previewId: `preview-${randomUUID()}`,
      idempotencyKey: `refund-${randomUUID()}`,
    };
    const firstRepository = new PostgresRefundExecutionRepository(pool);
    const secondRepository = new PostgresRefundExecutionRepository(pool);
    const attempts = await Promise.all([
      firstRepository.reserve(input),
      secondRepository.reserve(other),
    ]);
    assert.deepEqual(attempts.map((attempt) => attempt.kind).sort(), ['conflict', 'reserved']);

    const winner = attempts[0]?.kind === 'reserved' ? input : other;
    const loser = attempts[0]?.kind === 'reserved' ? other : input;
    const winnerExecution = attempts.find((attempt) => attempt.kind === 'reserved');
    assert.equal(winnerExecution?.kind, 'reserved');
    if (winnerExecution?.kind !== 'reserved') return;
    await firstRepository.recordOutcome(winnerExecution.executionId, 'FAILED');

    // A separate database pool must see the committed claim. FAILED is
    // deliberately not a release signal, including after a process restart.
    const restartPool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      const restartedRepository = new PostgresRefundExecutionRepository(restartPool);
      const replay = await restartedRepository.reserve(winner);
      assert.equal(replay.kind, 'existing');
      if (replay.kind === 'existing') assert.equal(replay.execution.status, 'FAILED');
      assert.deepEqual(await restartedRepository.reserve({ ...winner, reasonCode: 'OTHER' }), { kind: 'conflict' });
      assert.deepEqual(await restartedRepository.reserve({ ...winner, selection: { scope: 'SELECTED_ITEMS', itemIds: ['line-2'] } }), { kind: 'conflict' });
      assert.deepEqual(await restartedRepository.reserve(loser), { kind: 'conflict' });
    } finally {
      await restartPool.end();
    }

    const rows = await pool.query<{ executions: string; claims: string }>(
      `SELECT
        (SELECT count(*)::text FROM refund.executions WHERE tenant_id = $1 AND environment_id = $2 AND order_id = $3) AS executions,
        (SELECT count(*)::text FROM refund.order_claims WHERE tenant_id = $1 AND environment_id = $2 AND order_id = $3) AS claims`,
      [input.tenantId, input.environmentId, orderId],
    );
    assert.deepEqual(rows.rows[0], { executions: '1', claims: '1' });
  } finally {
    await pool.end();
  }
});
