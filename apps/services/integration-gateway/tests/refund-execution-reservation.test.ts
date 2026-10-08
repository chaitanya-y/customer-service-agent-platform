import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';

import { InMemoryRefundExecutionRepository, PostgresRefundExecutionRepository } from '../src/refund-execution-repository.js';

const input = { tenantId: 'tenant-local', environmentId: 'local', workflowId: 'workflow-1', previewId: 'preview-1', idempotencyKey: 'refund:workflow-1:preview-1', orderId: '3', amountMinor: 5_000, currency: 'USD', selection: { scope: 'FULL_ORDER' as const, itemIds: [] as string[] }, reasonCode: 'DAMAGED', occurredAt: '2026-10-02T12:00:00Z' };
const intentDigest = '833037836496d09829a47032bade4a9bb3d971b82ec888358f7b233fd25a6339';

test('a workflow preview cannot reserve another execution under a different key', async () => {
  const repository = new InMemoryRefundExecutionRepository();
  const first = await repository.reserve(input);
  assert.equal(first.kind, 'reserved');
  assert.deepEqual(await repository.reserve({ ...input, idempotencyKey: 'another-key' }), { kind: 'conflict' });
  assert.equal((await repository.getRefundOperationsSnapshot()).executionCounts.IN_PROGRESS, 1);
});

function postgresConflictRepository(rows: Record<string, unknown>[]) {
  return new PostgresRefundExecutionRepository({
    async connect() {
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql.startsWith('INSERT INTO refund.executions')) {
            // The insert must honor both unique constraints, not only the caller's key.
            assert.match(sql, /ON CONFLICT DO NOTHING RETURNING/);
            assert.deepEqual(values?.slice(1, 9), ['tenant-local', 'local', input.idempotencyKey, 'workflow-1', 'preview-1', '3', 5_000, 'USD']);
            return { rowCount: 0, rows: [] };
          }
          if (sql.startsWith('SELECT execution_id')) {
            assert.match(sql, /idempotency_key = \$3 OR \(workflow_id = \$4 AND preview_id = \$5\)/);
            assert.match(sql, /currency, execution_intent_sha256 FROM refund.executions/);
            assert.deepEqual(values, ['tenant-local', 'local', input.idempotencyKey, 'workflow-1', 'preview-1']);
            return { rowCount: rows.length, rows };
          }
          assert.ok(['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql));
          return { rowCount: 0, rows: [] };
        },
        release() {},
      };
    },
  } as unknown as Pool);
}

const existingRow = { execution_id: 'execution-1', status: 'SUCCEEDED', provider_refund_id: 'refund-1', idempotency_key: input.idempotencyKey, workflow_id: input.workflowId, preview_id: input.previewId, order_id: input.orderId, amount_minor: '5000', currency: 'USD', execution_intent_sha256: intentDigest };

test('Postgres reservation matches both uniqueness scopes and retains an exact retry outcome', async () => {
  assert.deepEqual(await postgresConflictRepository([existingRow]).reserve(input), { kind: 'existing', execution: { executionId: 'execution-1', status: 'SUCCEEDED', providerRefundId: 'refund-1' } });
});

test('Postgres reservation rejects changed intent, alternate keys, and two conflicting records', async () => {
  for (const mutation of [{ amount_minor: '7000' }, { order_id: '4' }, { currency: 'EUR' }, { preview_id: 'preview-2' }, { workflow_id: 'workflow-2' }, { idempotency_key: 'another-key' }]) {
    assert.deepEqual(await postgresConflictRepository([{ ...existingRow, ...mutation }]).reserve(input), { kind: 'conflict' });
  }
  assert.deepEqual(await postgresConflictRepository([existingRow, { ...existingRow, execution_id: 'execution-2', idempotency_key: 'another-key' }]).reserve(input), { kind: 'conflict' });
});

test('a missing Postgres conflict record fails closed instead of reserving a provider call', async () => {
  await assert.rejects(postgresConflictRepository([]).reserve(input), /REFUND_EXECUTION_RESERVATION_FAILED/);
});

test('an idempotency key cannot be reused for a different refund intent', async () => {
  const repository = new InMemoryRefundExecutionRepository();
  await repository.reserve(input);
  for (const mutation of [{ amountMinor: 7_000 }, { currency: 'EUR' }, { orderId: '4' }, { workflowId: 'workflow-2' }, { previewId: 'preview-2' }]) {
    assert.deepEqual(await repository.reserve({ ...input, ...mutation }), { kind: 'conflict' });
  }
});

test('same-key and same-preview replay conflicts when selection or reason changes', async () => {
  const repository = new InMemoryRefundExecutionRepository();
  const first = { ...input, selection: { scope: 'SELECTED_ITEMS' as const, itemIds: ['line-1'] } };
  await repository.reserve(first);
  for (const mutation of [{ reasonCode: 'OTHER' }, { selection: { scope: 'FULL_ORDER' as const, itemIds: [] } },
    { selection: { scope: 'SELECTED_ITEMS' as const, itemIds: ['line-2'] } },
    { selection: { scope: 'SELECTED_ITEMS' as const, itemIds: ['line-1', 'line-2'] } }]) {
    assert.deepEqual(await repository.reserve({ ...first, ...mutation }), { kind: 'conflict' });
  }
});

test('canonical item-set order preserves an exact replay without exposing mutable input references', async () => {
  const repository = new InMemoryRefundExecutionRepository();
  const selected = { ...input, selection: { scope: 'SELECTED_ITEMS' as const, itemIds: ['line-2', 'line-1'] } };
  const first = await repository.reserve(selected);
  assert.equal(first.kind, 'reserved');
  assert.equal((await repository.reserve({ ...selected, selection: { scope: 'SELECTED_ITEMS', itemIds: ['line-1', 'line-2'] } })).kind, 'existing');
  selected.selection.itemIds.push('line-3');
  assert.deepEqual(await repository.reserve(selected), { kind: 'conflict' });
});

test('Postgres replay requires a persisted exact intent digest and rejects unproven legacy rows', async () => {
  for (const digest of [null, undefined, '0'.repeat(64)]) {
    assert.deepEqual(await postgresConflictRepository([{ ...existingRow, execution_intent_sha256: digest }]).reserve(input), { kind: 'conflict' });
  }
  for (const mutation of [{ reasonCode: 'OTHER' }, { selection: { scope: 'SELECTED_ITEMS' as const, itemIds: ['line-1'] } }]) {
    assert.deepEqual(await postgresConflictRepository([existingRow]).reserve({ ...input, ...mutation }), { kind: 'conflict' });
  }
});

test('concurrent exact retries reserve once and preserve the recorded outcome', async () => {
  const repository = new InMemoryRefundExecutionRepository();
  const attempts = await Promise.all([repository.reserve(input), repository.reserve(input)]);
  assert.deepEqual(attempts.map((attempt) => attempt.kind), ['reserved', 'existing']);
  const first = attempts[0];
  assert.equal(first?.kind, 'reserved');
  if (first?.kind !== 'reserved') return;
  await repository.recordOutcome(first.executionId, 'PENDING_RECONCILIATION');
  assert.deepEqual(await repository.reserve(input), { kind: 'existing', execution: { executionId: first.executionId, status: 'PENDING_RECONCILIATION' } });
});

for (const status of ['IN_PROGRESS', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'PENDING_RECONCILIATION'] as const) {
  test(`an order claim remains exclusive after ${status}, including an exact retry`, async () => {
    const repository = new InMemoryRefundExecutionRepository();
    const first = await repository.reserve(input);
    assert.equal(first.kind, 'reserved');
    if (first.kind !== 'reserved') return;
    if (status !== 'IN_PROGRESS') await repository.recordOutcome(first.executionId, status);
    assert.deepEqual(await repository.reserve({ ...input, workflowId: 'workflow-2', previewId: 'preview-2', idempotencyKey: 'different-workflow-key' }), { kind: 'conflict' });
    assert.deepEqual(await repository.reserve(input), { kind: 'existing', execution: { executionId: first.executionId, status } });
    const snapshot = await repository.getRefundOperationsSnapshot();
    assert.equal(Object.values(snapshot.executionCounts).reduce((total, count) => total + count, 0), 1);
  });
}

test('concurrent distinct workflows cannot reserve the same order', async () => {
  const repository = new InMemoryRefundExecutionRepository();
  const results = await Promise.all([repository.reserve(input), repository.reserve({ ...input,
    workflowId: 'workflow-2', previewId: 'preview-2', idempotencyKey: 'different-workflow-key' })]);
  assert.deepEqual(results.map((result) => result.kind), ['reserved', 'conflict']);
});

test('order claims do not collide across tenants, environments, or orders', async () => {
  const repository = new InMemoryRefundExecutionRepository();
  await repository.reserve(input);
  for (const scope of [{ tenantId: 'other-tenant' }, { environmentId: 'other-environment' },
    { orderId: 'other-order', workflowId: 'workflow-2', previewId: 'preview-2', idempotencyKey: 'different-workflow-key' }]) {
    assert.equal((await repository.reserve({ ...input, ...scope })).kind, 'reserved');
  }
});

for (const claimFailure of ['occupied', 'missing-table'] as const) {
  test(`Postgres new execution fails closed and rolls back when the order claim is ${claimFailure}`, async () => {
    const calls: string[] = [];
    const repository = new PostgresRefundExecutionRepository({ async connect() { return {
      async query(sql: string, values?: unknown[]) {
        calls.push(sql);
        if (sql.startsWith('INSERT INTO refund.executions')) return { rowCount: 1, rows: [{ execution_id: 'execution-1', status: 'IN_PROGRESS', provider_refund_id: null }] };
        if (sql.startsWith('INSERT INTO refund.order_claims')) {
          assert.deepEqual(values?.slice(0, 3), ['tenant-local', 'local', '3']);
          assert.equal(typeof values?.[3], 'string');
          if (claimFailure === 'missing-table') throw new Error('relation refund.order_claims does not exist');
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }, release() {},
    }; } } as unknown as Pool);
    if (claimFailure === 'missing-table') await assert.rejects(repository.reserve(input), /order_claims does not exist/);
    else assert.deepEqual(await repository.reserve(input), { kind: 'conflict' });
    assert.ok(calls.includes('ROLLBACK'));
    assert.ok(!calls.includes('COMMIT'));
    assert.ok(!calls.some((sql) => sql.startsWith('INSERT INTO refund.audit_events')));
  });
}

for (const auditFails of [false, true]) {
  test(`Postgres execution, order claim, and audit ${auditFails ? 'roll back together on audit failure' : 'commit together before reservation succeeds'}`, async () => {
    const calls: string[] = [];
    let executionId: unknown;
    const repository = new PostgresRefundExecutionRepository({ async connect() { return {
      async query(sql: string, values?: unknown[]) {
        calls.push(sql);
        if (sql.startsWith('INSERT INTO refund.executions')) {
          assert.equal(values?.[10], intentDigest);
          executionId = values?.[0];
          return { rowCount: 1, rows: [{ execution_id: executionId, status: 'IN_PROGRESS', provider_refund_id: null }] };
        }
        if (sql.startsWith('INSERT INTO refund.order_claims')) {
          assert.deepEqual(values, ['tenant-local', 'local', '3', executionId, input.occurredAt]);
          return { rowCount: 1, rows: [{ order_id: '3' }] };
        }
        if (sql.startsWith('INSERT INTO refund.audit_events') && auditFails) throw new Error('synthetic audit failure');
        return { rowCount: 0, rows: [] };
      }, release() {},
    }; } } as unknown as Pool);
    if (auditFails) await assert.rejects(repository.reserve(input), /synthetic audit failure/);
    else assert.deepEqual(await repository.reserve(input), { kind: 'reserved', executionId });
    const claimIndex = calls.findIndex((sql) => sql.startsWith('INSERT INTO refund.order_claims'));
    const auditIndex = calls.findIndex((sql) => sql.startsWith('INSERT INTO refund.audit_events'));
    assert.ok(claimIndex > 0 && auditIndex > claimIndex);
    assert.equal(calls.at(-1), auditFails ? 'ROLLBACK' : 'COMMIT');
  });
}
