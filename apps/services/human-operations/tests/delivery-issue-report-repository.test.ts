import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Pool } from 'pg';

import {
  DeliveryIssueReportRepositoryError,
  InMemoryDeliveryIssueReportRepository,
  type DeliveryIssueReportRepository,
} from '../src/delivery-issue-report-repository.js';
import { PostgresDeliveryIssueReportRepository } from '../src/postgres-delivery-issue-report-repository.js';

const base = {
  tenantId: 'tenant-a',
  environmentId: 'local',
  customerId: 'customer-a',
  conversationId: 'conversation-a',
  orderReference: 'ORDER1234',
  category: 'DAMAGED' as const,
  idempotencyKey: 'create-key',
};

function errorCode(code: string) {
  return (error: unknown) => error instanceof DeliveryIssueReportRepositoryError && error.code === code;
}

async function exerciseReviewClosure(repository: DeliveryIssueReportRepository, input = base) {
  const received = await repository.create(input);
  const transition = { ...input, reportId: received.reportId, staffId: 'staff-a', expectedVersion: 1,
    idempotencyKey: 'close-key' };
  await assert.rejects(repository.close(transition), errorCode('REPORT_CONFLICT'));
  const claimed = await repository.claim({ ...transition, idempotencyKey: 'claim-key' });
  await assert.rejects(repository.close({ ...transition, expectedVersion: claimed.version }), errorCode('REPORT_CONFLICT'));
  const acknowledged = await repository.acknowledge({ ...transition, expectedVersion: claimed.version, idempotencyKey: 'ack-key' });
  const closeInput = { ...transition, expectedVersion: acknowledged.version };
  await assert.rejects(repository.close({ ...closeInput, staffId: 'staff-b' }), errorCode('REPORT_CONFLICT'));
  await assert.rejects(repository.close({ ...closeInput, expectedVersion: 2 }), errorCode('STALE_REPORT_VERSION'));
  await assert.rejects(repository.close({ ...closeInput, tenantId: 'foreign-tenant' }), errorCode('REPORT_NOT_FOUND'));
  await assert.rejects(repository.close({ ...closeInput, environmentId: 'production' }), errorCode('REPORT_NOT_FOUND'));
  await assert.rejects(repository.close({ ...closeInput, reportId: 'missing' }), errorCode('REPORT_NOT_FOUND'));
  assert.deepEqual(await repository.getForStaff(closeInput), acknowledged, 'rejected closes do not change the report');
  const closed = await repository.close(closeInput);
  assert.equal(closed.status, 'REVIEW_CLOSED');
  assert.equal(closed.version, 4);
  assert.equal(closed.assignedStaffId, 'staff-a');
  assert.equal(closed.acknowledgedAt, acknowledged.acknowledgedAt);
  assert.equal(closed.closedAt, closed.updatedAt);
  assert.ok(closed.closedAt);
  assert.deepEqual(await repository.close(closeInput), closed);
  await assert.rejects(repository.close({ ...closeInput, staffId: 'staff-b' }), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(repository.close({ ...closeInput, expectedVersion: 4 }), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(repository.close({ ...closeInput, idempotencyKey: 'different-close-key' }), errorCode('STALE_REPORT_VERSION'));
  for (const action of ['claim', 'acknowledge', 'close'] as const) {
    await assert.rejects(repository[action]({ ...closeInput, expectedVersion: 4, idempotencyKey: `terminal-${action}` }), errorCode('REPORT_CONFLICT'));
  }
  assert.equal((await repository.claim({ ...transition, idempotencyKey: 'claim-key' })).status, 'CLAIMED');
  assert.equal((await repository.acknowledge({ ...transition, expectedVersion: 2, idempotencyKey: 'ack-key' })).status, 'ACKNOWLEDGED');
  const events = await repository.auditEvents(closeInput);
  assert.deepEqual(events.map(event => [event.eventType, event.reportVersion]),
    [['REPORT_RECEIVED', 1], ['REPORT_CLAIMED', 2], ['REPORT_ACKNOWLEDGED', 3], ['REPORT_REVIEW_CLOSED', 4]]);
  assert.equal(events[3]?.actorId, 'staff-a');
  assert.equal(events[3]?.actorType, 'HUMAN');
  assert.equal(events[3]?.occurredAt, closed.closedAt);
  const safe = { reportId: received.reportId, orderReference: input.orderReference, category: input.category,
    status: 'REVIEW_CLOSED', createdAt: received.createdAt, updatedAt: closed.updatedAt };
  assert.deepEqual(await repository.getForCustomer(closeInput), safe);
  assert.deepEqual(await repository.replayForCustomer(input), safe);
  assert.deepEqual((await repository.listForCustomer(input)).reports, [safe]);
  assert.deepEqual(await repository.listForStaff({ ...input, staffId: 'staff-a', status: 'REVIEW_CLOSED' }), [closed]);
  assert.deepEqual(await repository.auditEvents(closeInput), events, 'reads and exact replays append no audit');
}

test('review closure is assigned-staff-only, exact-key replayable, scoped, audited, and terminal', async () => {
  await exerciseReviewClosure(new InMemoryDeliveryIssueReportRepository());
});

async function exerciseRepository(repository: DeliveryIssueReportRepository) {
  const received = await repository.create(base);
  assert.equal(received.status, 'RECEIVED');
  assert.equal(received.version, 1);
  assert.equal(received.category, 'DAMAGED');

  const replay = await repository.create(base);
  assert.deepEqual(replay, received, 'replay returns the original snapshot');
  await assert.rejects(repository.create({ ...base, category: 'MISSING' }), errorCode('IDEMPOTENCY_CONFLICT'));

  assert.deepEqual(await repository.replayForCustomer(base), {
    reportId: received.reportId, orderReference: 'ORDER1234', category: 'DAMAGED',
    status: 'RECEIVED', createdAt: received.createdAt, updatedAt: received.updatedAt,
  });
  await assert.rejects(repository.replayForCustomer({ ...base, idempotencyKey: 'unknown-key' }), errorCode('REPORT_NOT_FOUND'));
  await assert.rejects(repository.replayForCustomer({ ...base, customerId: 'other-customer' }), errorCode('REPORT_NOT_FOUND'));
  await assert.rejects(repository.replayForCustomer({ ...base, conversationId: 'other-conversation' }), errorCode('REPORT_NOT_FOUND'));
  await assert.rejects(repository.replayForCustomer({ ...base, tenantId: 'other-tenant' }), errorCode('REPORT_NOT_FOUND'));
  await assert.rejects(repository.replayForCustomer({ ...base, environmentId: 'production' }), errorCode('REPORT_NOT_FOUND'));
  await assert.rejects(repository.replayForCustomer({ ...base, category: 'WRONG' }), errorCode('IDEMPOTENCY_CONFLICT'));

  const customerView = await repository.getForCustomer({ ...base, reportId: received.reportId });
  assert.deepEqual(Object.keys(customerView).sort(), [
    'category', 'createdAt', 'orderReference', 'reportId', 'status', 'updatedAt',
  ]);
  await assert.rejects(
    repository.getForCustomer({ ...base, customerId: 'other-customer', reportId: received.reportId }),
    errorCode('REPORT_NOT_FOUND'),
  );
  await assert.rejects(
    repository.getForCustomer({ ...base, tenantId: 'other-tenant', reportId: received.reportId }),
    errorCode('REPORT_NOT_FOUND'),
  );
  await assert.rejects(
    repository.getForStaff({ ...base, environmentId: 'production', reportId: received.reportId }),
    errorCode('REPORT_NOT_FOUND'),
  );

  assert.equal((await repository.listForStaff({ ...base, staffId: 'staff-a' })).length, 1);
  assert.equal((await repository.listForStaff({ ...base, tenantId: 'other-tenant', staffId: 'staff-a' })).length, 0);
  assert.equal((await repository.listForStaff({ ...base, environmentId: 'production', staffId: 'staff-a' })).length, 0);

  const claimInput = {
    tenantId: base.tenantId,
    environmentId: base.environmentId,
    reportId: received.reportId,
    staffId: 'staff-a',
    expectedVersion: received.version,
    idempotencyKey: 'claim-key',
  };
  const claimed = await repository.claim(claimInput);
  assert.equal(claimed.status, 'CLAIMED');
  assert.equal(claimed.version, 2);
  assert.equal(claimed.assignedStaffId, 'staff-a');
  assert.deepEqual(await repository.claim(claimInput), claimed);
  await assert.rejects(repository.claim({ ...claimInput, staffId: 'staff-b' }), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(repository.claim({ ...claimInput, idempotencyKey: 'stale-key' }), errorCode('STALE_REPORT_VERSION'));
  await assert.rejects(repository.claim({ ...claimInput, expectedVersion: 2, staffId: 'staff-b', idempotencyKey: 'other-claim' }), errorCode('REPORT_CONFLICT'));

  const ackInput = { ...claimInput, expectedVersion: claimed.version, idempotencyKey: 'ack-key' };
  await assert.rejects(repository.acknowledge({ ...ackInput, staffId: 'staff-b' }), errorCode('REPORT_CONFLICT'));
  const acknowledged = await repository.acknowledge(ackInput);
  assert.equal(acknowledged.status, 'ACKNOWLEDGED');
  assert.equal(acknowledged.version, 3);
  assert.deepEqual(await repository.acknowledge(ackInput), acknowledged);
  assert.deepEqual(await repository.create(base), received, 'create replay is unaffected by later transitions');
  assert.deepEqual(await repository.replayForCustomer(base), {
    reportId: received.reportId, orderReference: 'ORDER1234', category: 'DAMAGED',
    status: 'ACKNOWLEDGED', createdAt: received.createdAt, updatedAt: acknowledged.updatedAt,
  }, 'receipt lookup returns current status, not the create snapshot');

  assert.deepEqual(
    (await repository.auditEvents({ ...base, reportId: received.reportId })).map((event) => [event.eventType, event.reportVersion, event.actorType]),
    [['REPORT_RECEIVED', 1, 'CUSTOMER'], ['REPORT_CLAIMED', 2, 'HUMAN'], ['REPORT_ACKNOWLEDGED', 3, 'HUMAN']],
  );
  await assert.rejects(
    repository.auditEvents({ ...base, tenantId: 'other-tenant', reportId: received.reportId }),
    errorCode('REPORT_NOT_FOUND'),
  );
}

test('in-memory delivery report repository enforces replay, ownership, scope, transitions, and audit', async () => {
  let sequence = 0;
  const repository = new InMemoryDeliveryIssueReportRepository(
    () => new Date('2026-10-02T12:00:00.000Z'),
    () => `id-${++sequence}`,
  );
  await exerciseRepository(repository);
});

test('create keys are private to each customer conversation, even when the key text is identical', async () => {
  const repository = new InMemoryDeliveryIssueReportRepository();
  const first = await repository.create(base);
  const second = await repository.create({ ...base, customerId: 'customer-b', conversationId: 'conversation-b' });
  const third = await repository.create({ ...base, conversationId: 'conversation-c' });
  assert.notEqual(first.reportId, second.reportId);
  assert.notEqual(first.reportId, third.reportId);
  assert.notEqual(second.reportId, third.reportId);
  await assert.rejects(
    repository.getForCustomer({ ...base, customerId: 'customer-b', reportId: first.reportId }),
    errorCode('REPORT_NOT_FOUND'),
  );
});

test('customer history is owner-scoped, newest-first, capped at ten, and has no audit side effect', async () => {
  let sequence = 0;
  let second = 0;
  const repository = new InMemoryDeliveryIssueReportRepository(
    () => new Date(Date.UTC(2026, 9, 2, 12, 0, second++)),
    () => `history-${++sequence}`,
  );
  const scope = { tenantId: 'tenant-a', environmentId: 'local', customerId: 'customer-a' };
  assert.deepEqual(await repository.listForCustomer(scope), { reports: [], hasMore: false });
  const owned = [];
  for (let index = 0; index < 11; index++) {
    owned.push(await repository.create({ ...scope, conversationId: `conversation-${index}`,
      orderReference: `ORDER${index}`, category: 'DAMAGED', idempotencyKey: `history-key-${index}` }));
    if (index === 9) assert.equal((await repository.listForCustomer(scope)).hasMore, false);
  }
  await repository.create({ ...scope, customerId: 'customer-b', conversationId: 'foreign-customer',
    orderReference: 'FOREIGN', category: 'WRONG', idempotencyKey: 'foreign-customer-key' });
  await repository.create({ ...scope, tenantId: 'tenant-b', conversationId: 'foreign-tenant',
    orderReference: 'FOREIGN', category: 'WRONG', idempotencyKey: 'foreign-tenant-key' });
  await repository.create({ ...scope, environmentId: 'production', conversationId: 'foreign-environment',
    orderReference: 'FOREIGN', category: 'WRONG', idempotencyKey: 'foreign-environment-key' });
  await repository.claim({ ...scope, reportId: owned[0]!.reportId, staffId: 'staff-a',
    expectedVersion: 1, idempotencyKey: 'history-claim-key' });
  const beforeAudit = await repository.auditEvents({ ...scope, reportId: owned[10]!.reportId });
  const history = await repository.listForCustomer(scope);
  assert.equal(history.hasMore, true);
  assert.deepEqual(history.reports.map((report) => report.orderReference),
    ['ORDER0', 'ORDER10', 'ORDER9', 'ORDER8', 'ORDER7', 'ORDER6', 'ORDER5', 'ORDER4', 'ORDER3', 'ORDER2']);
  assert.equal(history.reports[0]?.status, 'CLAIMED');
  assert.deepEqual(Object.keys(history.reports[0]!).sort(),
    ['category', 'createdAt', 'orderReference', 'reportId', 'status', 'updatedAt']);
  assert.deepEqual(await repository.auditEvents({ ...scope, reportId: owned[10]!.reportId }), beforeAudit);
  const otherCustomer = await repository.listForCustomer({ ...scope, customerId: 'customer-b' });
  assert.deepEqual(otherCustomer.reports.map((report) => report.orderReference), ['FOREIGN']);
  assert.equal(otherCustomer.hasMore, false);
  assert.deepEqual(await repository.listForCustomer({ ...scope, customerId: 'unknown' }), { reports: [], hasMore: false });
});

const databaseUrl = process.env.HUMAN_OPERATIONS_TEST_DATABASE_URL;
test('PostgreSQL review closure enforces ownership, exact replay, scope, audit, and terminal state',
  { skip: databaseUrl ? false : 'HUMAN_OPERATIONS_TEST_DATABASE_URL is not set' }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
      assert.equal(role.rows[0]?.rolsuper, false);
      assert.equal(role.rows[0]?.rolbypassrls, false);
      await exerciseReviewClosure(new PostgresDeliveryIssueReportRepository(pool),
        { ...base, tenantId: `delivery-close-test-${randomUUID()}` });
    } finally { await pool.end(); }
  });

test('PostgreSQL failed close audit rolls back status and key so the close can be retried',
  { skip: databaseUrl ? false : 'HUMAN_OPERATIONS_TEST_DATABASE_URL is not set' }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const ids = ['report', 'duplicate-audit', 'claim-audit', 'ack-audit', 'duplicate-audit'];
    const repository = new PostgresDeliveryIssueReportRepository(pool, () => new Date(), () => ids.shift() ?? randomUUID());
    const input = { ...base, tenantId: `delivery-close-rollback-${randomUUID()}` };
    try {
      const received = await repository.create(input);
      const transition = { ...input, reportId: received.reportId, staffId: 'staff-a', expectedVersion: 1, idempotencyKey: 'claim-key' };
      await repository.claim(transition);
      const acknowledged = await repository.acknowledge({ ...transition, expectedVersion: 2, idempotencyKey: 'ack-key' });
      const closeInput = { ...transition, expectedVersion: 3, idempotencyKey: 'close-key' };
      await assert.rejects(repository.close(closeInput), { code: '23505' });
      assert.deepEqual(await repository.getForStaff(closeInput), acknowledged);
      assert.equal((await repository.auditEvents(closeInput)).length, 3);
      const closed = await repository.close(closeInput);
      assert.equal(closed.status, 'REVIEW_CLOSED');
      assert.equal(closed.version, 4);
      assert.equal((await repository.auditEvents(closeInput)).length, 4);
    } finally { await pool.end(); }
  });

test('PostgreSQL delivery report repository commits scoped report, idempotency, and audit atomically',
  { skip: databaseUrl ? false : 'HUMAN_OPERATIONS_TEST_DATABASE_URL is not set' },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const repository = new PostgresDeliveryIssueReportRepository(pool);
    const scopedBase = { ...base, tenantId: `delivery-test-${randomUUID()}`, idempotencyKey: randomUUID() };
    try {
      const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      assert.equal(role.rows[0]?.rolsuper, false, 'integration tests must use a non-superuser app role');
      assert.equal(role.rows[0]?.rolbypassrls, false, 'integration tests must not bypass RLS');
      const received = await repository.create(scopedBase);
      assert.deepEqual(await repository.create(scopedBase), received);
      assert.equal((await repository.auditEvents({ ...scopedBase, reportId: received.reportId })).length, 1);
      await assert.rejects(repository.create({ ...scopedBase, category: 'WRONG' }), errorCode('IDEMPOTENCY_CONFLICT'));
      await assert.rejects(repository.getForCustomer({ ...scopedBase, customerId: 'other', reportId: received.reportId }), errorCode('REPORT_NOT_FOUND'));
      const claimed = await repository.claim({ ...scopedBase, reportId: received.reportId, staffId: 'staff-a', expectedVersion: 1, idempotencyKey: randomUUID() });
      await assert.rejects(repository.claim({ ...scopedBase, reportId: received.reportId, staffId: 'staff-b', expectedVersion: 1, idempotencyKey: randomUUID() }), errorCode('STALE_REPORT_VERSION'));
      const acknowledged = await repository.acknowledge({ ...scopedBase, reportId: received.reportId, staffId: 'staff-a', expectedVersion: claimed.version, idempotencyKey: randomUUID() });
      assert.equal(acknowledged.status, 'ACKNOWLEDGED');
      const countRows = async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN READ ONLY');
          await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.environment_id', $2, true)`, [scopedBase.tenantId, scopedBase.environmentId]);
          const counts = await client.query<{ reports: string; keys: string; audits: string }>(
            `SELECT
              (SELECT count(*) FROM human_operations.delivery_issue_reports) AS reports,
              (SELECT count(*) FROM human_operations.delivery_issue_report_idempotency) AS keys,
              (SELECT count(*) FROM human_operations.delivery_issue_report_audit_events) AS audits`,
          );
          await client.query('COMMIT');
          return counts.rows[0];
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      };
      const beforeReplay = await countRows();
      assert.deepEqual(await repository.replayForCustomer(scopedBase), {
        reportId: received.reportId, orderReference: received.orderReference, category: received.category,
        status: 'ACKNOWLEDGED', createdAt: received.createdAt, updatedAt: acknowledged.updatedAt,
      });
      await assert.rejects(repository.replayForCustomer({ ...scopedBase, idempotencyKey: randomUUID() }), errorCode('REPORT_NOT_FOUND'));
      await assert.rejects(repository.replayForCustomer({ ...scopedBase, customerId: 'other-customer' }), errorCode('REPORT_NOT_FOUND'));
      await assert.rejects(repository.replayForCustomer({ ...scopedBase, tenantId: `${scopedBase.tenantId}-other` }), errorCode('REPORT_NOT_FOUND'));
      await assert.rejects(repository.replayForCustomer({ ...scopedBase, category: 'WRONG' }), errorCode('IDEMPOTENCY_CONFLICT'));
      assert.deepEqual(await countRows(), beforeReplay, 'replay never writes report, idempotency, or audit rows');
      assert.deepEqual(
        (await repository.auditEvents({ ...scopedBase, reportId: received.reportId })).map((event) => event.eventType),
        ['REPORT_RECEIVED', 'REPORT_CLAIMED', 'REPORT_ACKNOWLEDGED'],
      );
      const otherCustomer = await repository.create({ ...scopedBase, customerId: 'customer-b', conversationId: 'conversation-b' });
      assert.notEqual(otherCustomer.reportId, received.reportId);
      const client = await pool.connect();
      try {
        assert.equal((await client.query('SELECT report_id FROM human_operations.delivery_issue_reports WHERE report_id = $1', [received.reportId])).rowCount, 0);
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.environment_id', $2, true)`, [`${scopedBase.tenantId}-other`, scopedBase.environmentId]);
        const masked = await client.query('SELECT report_id FROM human_operations.delivery_issue_reports WHERE report_id = $1', [received.reportId]);
        assert.equal(masked.rowCount, 0, 'RLS masks another tenant even without an explicit SQL tenant predicate');
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.environment_id', $2, true)`, [scopedBase.tenantId, scopedBase.environmentId]);
        await assert.rejects(
          client.query('UPDATE human_operations.delivery_issue_reports SET tenant_id = $1 WHERE report_id = $2', ['other-tenant', received.reportId]),
          { code: '42501' },
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

test('PostgreSQL rolls back report and idempotency reservation when audit insert fails',
  { skip: databaseUrl ? false : 'HUMAN_OPERATIONS_TEST_DATABASE_URL is not set' },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const tenantId = `delivery-test-${randomUUID()}`;
    const ids = ['first', 'duplicate-audit', 'rolled-back', 'duplicate-audit'];
    const repository = new PostgresDeliveryIssueReportRepository(pool, () => new Date(), () => ids.shift() ?? randomUUID());
    const input = { ...base, tenantId, idempotencyKey: 'first-key' };
    try {
      await repository.create(input);
      const failedInput = { ...input, idempotencyKey: 'rollback-key', orderReference: 'ORDER9999' };
      await assert.rejects(repository.create(failedInput), { code: '23505' });
      await assert.rejects(repository.getForStaff({ tenantId, environmentId: 'local', reportId: 'delivery-rolled-back' }), errorCode('REPORT_NOT_FOUND'));
      const retry = await new PostgresDeliveryIssueReportRepository(pool).create(failedInput);
      assert.equal(retry.orderReference, 'ORDER9999', 'the failed reservation was rolled back and can be retried');
    } finally {
      await pool.end();
    }
  });

test('PostgreSQL customer history uses RLS, owner scope, eleven-row bound, and no writes',
  { skip: databaseUrl ? false : 'HUMAN_OPERATIONS_TEST_DATABASE_URL is not set' },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const tenantId = `delivery-history-test-${randomUUID()}`;
    let second = 0;
    const repository = new PostgresDeliveryIssueReportRepository(pool,
      () => new Date(Date.UTC(2026, 9, 2, 12, 0, second++)));
    const scope = { tenantId, environmentId: 'local', customerId: 'customer-a' };
    let oldestReportId: string | undefined;
    const countRows = async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.environment_id', $2, true)`, [tenantId, 'local']);
        const result = await client.query<{ reports: string; keys: string; audits: string }>(
          `SELECT (SELECT count(*) FROM human_operations.delivery_issue_reports) AS reports,
            (SELECT count(*) FROM human_operations.delivery_issue_report_idempotency) AS keys,
            (SELECT count(*) FROM human_operations.delivery_issue_report_audit_events) AS audits`,
        );
        await client.query('COMMIT');
        return result.rows[0];
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    try {
      const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      assert.equal(role.rows[0]?.rolsuper, false);
      assert.equal(role.rows[0]?.rolbypassrls, false);
      for (let index = 0; index < 11; index++) {
        const report = await repository.create({ ...scope, conversationId: `history-${index}`,
          orderReference: `ORDER${index}`, category: 'DAMAGED', idempotencyKey: `history-key-${index}` });
        if (index === 0) oldestReportId = report.reportId;
      }
      await repository.create({ ...scope, customerId: 'customer-b', conversationId: 'history-other',
        orderReference: 'FOREIGN', category: 'WRONG', idempotencyKey: 'history-key-other' });
      assert.ok(oldestReportId);
      await repository.claim({ ...scope, reportId: oldestReportId, staffId: 'staff-a',
        expectedVersion: 1, idempotencyKey: 'history-claim-key' });
      const before = await countRows();
      const history = await repository.listForCustomer(scope);
      assert.equal(history.hasMore, true);
      assert.deepEqual(history.reports.map((report) => report.orderReference),
        ['ORDER0', 'ORDER10', 'ORDER9', 'ORDER8', 'ORDER7', 'ORDER6', 'ORDER5', 'ORDER4', 'ORDER3', 'ORDER2']);
      assert.equal(history.reports[0]?.status, 'CLAIMED');
      assert.deepEqual(Object.keys(history.reports[0]!).sort(),
        ['category', 'createdAt', 'orderReference', 'reportId', 'status', 'updatedAt']);
      assert.deepEqual(await repository.listForCustomer({ ...scope, customerId: 'unknown' }), { reports: [], hasMore: false });
      assert.deepEqual(await repository.listForCustomer({ ...scope, tenantId: `${tenantId}-other` }), { reports: [], hasMore: false });
      assert.deepEqual(await repository.listForCustomer({ ...scope, environmentId: 'production' }), { reports: [], hasMore: false });
      assert.deepEqual(await countRows(), before);
    } finally { await pool.end(); }
  });
