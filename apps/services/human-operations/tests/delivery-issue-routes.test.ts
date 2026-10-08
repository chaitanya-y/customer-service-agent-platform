import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';

import { buildApp } from '../src/app.js';
import { createDeliveryReportAssertionVerifier, DELIVERY_REPORT_ASSERTION_HEADER } from '../src/delivery-report-access.js';
import { createDeliveryStaffAssertionVerifier, DELIVERY_STAFF_ASSERTION_HEADER } from '../src/delivery-staff-access.js';
import { InMemoryDeliveryIssueReportRepository } from '../src/delivery-issue-report-repository.js';
import { createHumanAssertionVerifier } from '../src/human-access.js';

const secret = 'a-long-delivery-test-secret-1234567890';
const now = new Date('2026-10-02T12:00:00.000Z');
const issuedAt = Math.floor(now.getTime() / 1000);
const body = { order_reference: 'ORDER1234', category: 'DAMAGED' } as const;
const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
async function sign(payload: Record<string, unknown>, audience: string, typ: string, lifetime = 60) {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256', typ })
    .setIssuer('edge').setAudience(audience).setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + lifetime).sign(new TextEncoder().encode(secret));
}
function createAssertion(overrides: Record<string, unknown> = {}) {
  return sign({ tenantId: 'tenant-a', environmentId: 'local', subjectCustomerId: 'customer-a',
    conversationId: 'conversation-a', orderReference: body.order_reference, category: body.category,
    idempotencyKey: 'request-key', requestId: 'request-a', bodySha256: digest,
    purpose: 'delivery_issue_report_create', ...overrides }, 'human-operations-delivery-report', 'cso-delivery-report+jwt');
}
function readAssertion(reportId: string, customerId = 'customer-a') {
  return sign({ tenantId: 'tenant-a', environmentId: 'local', subjectCustomerId: customerId,
    reportId, requestId: 'request-b', purpose: 'delivery_issue_report_read' }, 'human-operations-delivery-report', 'cso-delivery-report+jwt');
}
function listAssertion(customerId = 'customer-a') {
  return sign({ tenantId: 'tenant-a', environmentId: 'local', subjectCustomerId: customerId,
    requestId: 'request-list', purpose: 'delivery_issue_report_list' }, 'human-operations-delivery-report', 'cso-delivery-report+jwt');
}
function staffAssertion(role: string = 'DELIVERY_AGENT', tenantId = 'tenant-a', staffId = 'staff-a') {
  return sign({ staffId, tenantId, environmentId: 'local', role }, 'human-operations-delivery-staff', 'cso-delivery-staff+jwt', 300);
}
function appForTest(repository = new InMemoryDeliveryIssueReportRepository(() => now, () => 'one')) {
  const app = buildApp({
    verifyHuman: createHumanAssertionVerifier({ secret, issuer: 'edge', audience: 'human-operations', tenantId: 'tenant-a', environmentId: 'local' }),
    async sendDecision() { throw new Error('Refund path must remain unreachable'); },
    delivery: {
      repository,
      verifyCustomer: createDeliveryReportAssertionVerifier({ secret, issuer: 'edge', tenantId: 'tenant-a', environmentId: 'local', now: () => now }),
      verifyStaff: createDeliveryStaffAssertionVerifier({ secret, issuer: 'edge', tenantId: 'tenant-a', environmentId: 'local', now: () => now }),
    },
  });
  return app;
}

function replayAssertion(overrides: Record<string, unknown> = {}) {
  return createAssertion({ purpose: 'delivery_issue_report_replay', ...overrides });
}

test('internal replay finds current owner receipt without another report or audit event', async (context) => {
  const repository = new InMemoryDeliveryIssueReportRepository(() => now, () => 'one');
  const app = appForTest(repository); context.after(() => app.close());
  const createHeaders = { [DELIVERY_REPORT_ASSERTION_HEADER]: await createAssertion(), 'idempotency-key': 'request-key' };
  const created = await app.inject({ method: 'POST', url: '/internal/v1/delivery-issue-reports', headers: createHeaders, payload: body });
  assert.equal(created.statusCode, 201);
  const reportId = created.json().delivery_issue_report.report_id as string;
  await repository.claim({ tenantId: 'tenant-a', environmentId: 'local', reportId,
    staffId: 'staff-a', expectedVersion: 1, idempotencyKey: 'claim-key' });
  const beforeAudit = await repository.auditEvents({ tenantId: 'tenant-a', environmentId: 'local', reportId });
  const replay = await app.inject({ method: 'POST', url: '/internal/v1/delivery-issue-reports/replay',
    headers: { ...createHeaders, [DELIVERY_REPORT_ASSERTION_HEADER]: await replayAssertion() }, payload: body });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers['cache-control'], 'private, no-store');
  assert.deepEqual(replay.json().delivery_issue_report, {
    ...created.json().delivery_issue_report, status: 'CLAIMED',
  });
  assert.deepEqual(Object.keys(replay.json().delivery_issue_report).sort(),
    ['category', 'created_at', 'order_reference', 'report_id', 'status', 'updated_at']);
  assert.deepEqual(await repository.auditEvents({ tenantId: 'tenant-a', environmentId: 'local', reportId }), beforeAudit);
  assert.equal((await repository.listForStaff({ tenantId: 'tenant-a', environmentId: 'local', staffId: 'staff-a' })).length, 1);
});

test('internal replay masks unknown scope and rejects changed signed input without creating', async (context) => {
  const repository = new InMemoryDeliveryIssueReportRepository(() => now, () => 'one');
  const app = appForTest(repository); context.after(() => app.close());
  const created = await app.inject({ method: 'POST', url: '/internal/v1/delivery-issue-reports',
    headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: await createAssertion(), 'idempotency-key': 'request-key' }, payload: body });
  assert.equal(created.statusCode, 201);
  const request = async (assertion: string, payload: unknown = body, key = 'request-key') => app.inject({
    method: 'POST', url: '/internal/v1/delivery-issue-reports/replay',
    headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: assertion, 'idempotency-key': key }, payload,
  });
  for (const overrides of [
    { subjectCustomerId: 'customer-b' }, { conversationId: 'conversation-b' }, { idempotencyKey: 'unknown-key' },
  ]) {
    const result = await request(await replayAssertion(overrides), body, overrides.idempotencyKey ?? 'request-key');
    assert.equal(result.statusCode, 404);
    assert.equal(result.headers['cache-control'], 'private, no-store');
    assert.deepEqual(result.json(), { error: { code: 'delivery_report_not_found', message: 'Delivery issue report was not found.' } });
  }
  const changedBody = { ...body, category: 'WRONG' };
  const changed = await request(await replayAssertion({ category: 'WRONG', bodySha256: createHash('sha256').update(JSON.stringify(changedBody)).digest('hex') }), changedBody);
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.headers['cache-control'], 'private, no-store');
  assert.deepEqual(changed.json(), { error: { code: 'delivery_report_conflict', message: 'Delivery issue report could not be changed.' } });
  assert.equal((await repository.listForStaff({ tenantId: 'tenant-a', environmentId: 'local', staffId: 'staff-a' })).length, 1);
  const reportId = created.json().delivery_issue_report.report_id as string;
  assert.equal((await repository.auditEvents({ tenantId: 'tenant-a', environmentId: 'local', reportId })).length, 1);
  assert.equal((await request(await createAssertion())).statusCode, 401);
  assert.equal((await request(await replayAssertion(), { ...body, customer_id: 'customer-b' })).statusCode, 400);
});

test('internal customer history is bounded, safe, and rejects filters or wrong purpose', async (context) => {
  let sequence = 0;
  let second = 0;
  const repository = new InMemoryDeliveryIssueReportRepository(
    () => new Date(Date.UTC(2026, 9, 2, 12, 0, second++)), () => `list-${++sequence}`,
  );
  const app = appForTest(repository); context.after(() => app.close());
  const url = '/internal/v1/delivery-issue-reports';
  const headers = { [DELIVERY_REPORT_ASSERTION_HEADER]: await listAssertion() };
  const empty = await app.inject({ method: 'GET', url, headers });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), { delivery_issue_reports: [], has_more: false });
  for (let index = 0; index < 11; index++) {
    await repository.create({ tenantId: 'tenant-a', environmentId: 'local', customerId: 'customer-a',
      conversationId: `conversation-${index}`, orderReference: `ORDER${index}`, category: 'DAMAGED',
      idempotencyKey: `history-key-${index}` });
  }
  await repository.create({ tenantId: 'tenant-a', environmentId: 'local', customerId: 'customer-b',
    conversationId: 'other-customer', orderReference: 'FOREIGN', category: 'WRONG', idempotencyKey: 'other-key' });
  const found = await app.inject({ method: 'GET', url, headers });
  assert.equal(found.statusCode, 200);
  assert.equal(found.headers['cache-control'], 'private, no-store');
  assert.equal(found.json().has_more, true);
  assert.deepEqual(found.json().delivery_issue_reports.map((report: { order_reference: string }) => report.order_reference),
    ['ORDER10', 'ORDER9', 'ORDER8', 'ORDER7', 'ORDER6', 'ORDER5', 'ORDER4', 'ORDER3', 'ORDER2', 'ORDER1']);
  assert.deepEqual(Object.keys(found.json().delivery_issue_reports[0]).sort(),
    ['category', 'created_at', 'order_reference', 'report_id', 'status', 'updated_at']);
  const wrongPurpose = await app.inject({ method: 'GET', url,
    headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: await createAssertion() } });
  assert.equal(wrongPurpose.statusCode, 401);
  assert.equal(wrongPurpose.headers['cache-control'], 'private, no-store');
  const filter = await app.inject({ method: 'GET', url: `${url}?customer_id=customer-b`, headers });
  assert.equal(filter.statusCode, 400);
  assert.equal(filter.headers['cache-control'], 'private, no-store');
  const withBody = await app.inject({ method: 'GET', url,
    headers: { ...headers, 'content-type': 'application/json' }, payload: { customer_id: 'customer-b' } });
  assert.equal(withBody.statusCode, 400);
  assert.equal(withBody.headers['cache-control'], 'private, no-store');
  const other = await app.inject({ method: 'GET', url,
    headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: await listAssertion('customer-b') } });
  assert.deepEqual(other.json().delivery_issue_reports.map((report: { order_reference: string }) => report.order_reference), ['FOREIGN']);
});

test('internal create and owner read return only the six customer-safe fields', async (context) => {
  const app = appForTest(); context.after(() => app.close());
  const assertion = await createAssertion();
  const headers = { [DELIVERY_REPORT_ASSERTION_HEADER]: assertion, 'idempotency-key': 'request-key' };
  const created = await app.inject({ method: 'POST', url: '/internal/v1/delivery-issue-reports', headers, payload: body });
  assert.equal(created.statusCode, 201);
  const report = created.json().delivery_issue_report;
  assert.deepEqual(Object.keys(report).sort(), ['category', 'created_at', 'order_reference', 'report_id', 'status', 'updated_at']);
  assert.equal(report.status, 'RECEIVED');
  assert.deepEqual((await app.inject({ method: 'POST', url: '/internal/v1/delivery-issue-reports', headers, payload: body })).json(), created.json());
  const read = await app.inject({ method: 'GET', url: `/internal/v1/delivery-issue-reports/${report.report_id}`,
    headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: await readAssertion(report.report_id) } });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), created.json());
  const stranger = await app.inject({ method: 'GET', url: `/internal/v1/delivery-issue-reports/${report.report_id}`,
    headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: await readAssertion(report.report_id, 'customer-b') } });
  assert.equal(stranger.statusCode, 404);
});

test('internal create rejects mismatched signed values and invalid bodies before persistence', async (context) => {
  const app = appForTest(); context.after(() => app.close());
  const assertion = await createAssertion();
  const missingKey = await app.inject({ method: 'POST', url: '/internal/v1/delivery-issue-reports', headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: assertion }, payload: body });
  assert.equal(missingKey.statusCode, 400);
  const changed = await app.inject({ method: 'POST', url: '/internal/v1/delivery-issue-reports',
    headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: assertion, 'idempotency-key': 'request-key' }, payload: { ...body, category: 'MISSING' } });
  assert.equal(changed.statusCode, 401);
  const extra = await app.inject({ method: 'POST', url: '/internal/v1/delivery-issue-reports',
    headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: assertion, 'idempotency-key': 'request-key' }, payload: { ...body, customer_id: 'customer-b' } });
  assert.equal(extra.statusCode, 400);
});

test('a reused create key with a different signed report is a conflict', async (context) => {
  const app = appForTest(); context.after(() => app.close());
  const headers = { [DELIVERY_REPORT_ASSERTION_HEADER]: await createAssertion(), 'idempotency-key': 'request-key' };
  assert.equal((await app.inject({ method: 'POST', url: '/internal/v1/delivery-issue-reports', headers, payload: body })).statusCode, 201);
  const changedBody = { ...body, category: 'WRONG' } as const;
  const changedAssertion = await createAssertion({ category: 'WRONG',
    bodySha256: createHash('sha256').update(JSON.stringify(changedBody)).digest('hex') });
  const conflict = await app.inject({ method: 'POST', url: '/internal/v1/delivery-issue-reports',
    headers: { ...headers, [DELIVERY_REPORT_ASSERTION_HEADER]: changedAssertion }, payload: changedBody });
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(Object.keys(conflict.json()), ['error']);
});

test('delivery staff list, detail, claim, and acknowledge are isolated from refund authorization', async (context) => {
  const app = appForTest(); context.after(() => app.close());
  const created = await app.inject({ method: 'POST', url: '/internal/v1/delivery-issue-reports',
    headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: await createAssertion(), 'idempotency-key': 'request-key' }, payload: body });
  const reportId = created.json().delivery_issue_report.report_id as string;
  const staff = await staffAssertion();
  const headers = { [DELIVERY_STAFF_ASSERTION_HEADER]: staff };
  const list = await app.inject({ method: 'GET', url: '/v1/delivery-issue-reports?status=RECEIVED&assignee=unassigned', headers });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().delivery_issue_reports.length, 1);
  assert.equal(list.json().delivery_issue_reports[0].version, 1);
  const detail = await app.inject({ method: 'GET', url: `/v1/delivery-issue-reports/${reportId}`, headers });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().audit_events[0].event_type, 'REPORT_RECEIVED');
  const refund = await app.inject({ method: 'GET', url: '/v1/refund-cases', headers: { 'x-cso-human-assertion': staff } });
  assert.equal(refund.statusCode, 401);
  const claimHeaders = { ...headers, 'idempotency-key': 'claim-key' };
  const claim = await app.inject({ method: 'POST', url: `/v1/delivery-issue-reports/${reportId}/claim`, headers: claimHeaders, payload: { expected_version: 1 } });
  assert.equal(claim.statusCode, 200);
  assert.equal(claim.json().delivery_issue_report.status, 'CLAIMED');
  assert.equal(claim.json().delivery_issue_report.assigned_staff_id, 'staff-a');
  assert.deepEqual((await app.inject({ method: 'POST', url: `/v1/delivery-issue-reports/${reportId}/claim`, headers: claimHeaders, payload: { expected_version: 1 } })).json(), claim.json());
  const stale = await app.inject({ method: 'POST', url: `/v1/delivery-issue-reports/${reportId}/claim`,
    headers: { ...headers, 'idempotency-key': 'other-claim-key' }, payload: { expected_version: 1 } });
  assert.equal(stale.statusCode, 409);
  const other = await staffAssertion('DELIVERY_AGENT', 'tenant-a', 'staff-b');
  const denied = await app.inject({ method: 'POST', url: `/v1/delivery-issue-reports/${reportId}/acknowledge`,
    headers: { [DELIVERY_STAFF_ASSERTION_HEADER]: other, 'idempotency-key': 'ack-other' }, payload: { expected_version: 2 } });
  assert.equal(denied.statusCode, 409);
  const ack = await app.inject({ method: 'POST', url: `/v1/delivery-issue-reports/${reportId}/acknowledge`,
    headers: { ...headers, 'idempotency-key': 'acknowledge-key' }, payload: { expected_version: 2 } });
  assert.equal(ack.statusCode, 200);
  assert.equal(ack.json().delivery_issue_report.status, 'ACKNOWLEDGED');
  assert.equal(ack.json().delivery_issue_report.version, 3);
});

test('delivery staff rejects refund role, foreign tenant, and stale version with safe errors', async (context) => {
  const app = appForTest(); context.after(() => app.close());
  const refundRole = await staffAssertion('REFUND_SUPERVISOR');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/delivery-issue-reports', headers: { [DELIVERY_STAFF_ASSERTION_HEADER]: refundRole } })).statusCode, 401);
  const foreign = await staffAssertion('DELIVERY_AGENT', 'tenant-b');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/delivery-issue-reports', headers: { [DELIVERY_STAFF_ASSERTION_HEADER]: foreign } })).statusCode, 401);
  const staff = await staffAssertion();
  const invalid = await app.inject({ method: 'POST', url: '/v1/delivery-issue-reports/not-found/claim',
    headers: { [DELIVERY_STAFF_ASSERTION_HEADER]: staff, 'idempotency-key': 'claim-key' }, payload: { expected_version: 0 } });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(Object.keys(invalid.json()), ['error']);
});

test('staff close requires a strict version body and delivery authorization, then returns audited review closure', async (context) => {
  const repository = new InMemoryDeliveryIssueReportRepository(() => now, () => 'one');
  const app = appForTest(repository); context.after(() => app.close());
  const created = await app.inject({ method: 'POST', url: '/internal/v1/delivery-issue-reports',
    headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: await createAssertion(), 'idempotency-key': 'request-key' }, payload: body });
  const reportId = created.json().delivery_issue_report.report_id as string;
  const url = `/v1/delivery-issue-reports/${reportId}/close`;
  const headers = { [DELIVERY_STAFF_ASSERTION_HEADER]: await staffAssertion(), 'idempotency-key': 'close-key' };
  for (const payload of [{}, { expected_version: 0 }, { expected_version: 1.5 }, { expected_version: '3' },
    { expected_version: 3, staff_id: 'staff-a' }, { expected_version: 3, resolved: true }]) {
    assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: 'POST', url, headers: { [DELIVERY_STAFF_ASSERTION_HEADER]: headers[DELIVERY_STAFF_ASSERTION_HEADER] },
    payload: { expected_version: 3 } })).statusCode, 400);
  for (const unauthorizedHeaders of [{}, { [DELIVERY_REPORT_ASSERTION_HEADER]: await createAssertion() },
    { [DELIVERY_STAFF_ASSERTION_HEADER]: await staffAssertion('REFUND_SUPERVISOR') },
    { [DELIVERY_STAFF_ASSERTION_HEADER]: await staffAssertion('DELIVERY_AGENT', 'tenant-b') }]) {
    assert.equal((await app.inject({ method: 'POST', url, headers: { ...unauthorizedHeaders, 'idempotency-key': 'close-key' },
      payload: { expected_version: 3 } })).statusCode, 401);
  }
  assert.equal((await app.inject({ method: 'POST', url: `/internal/v1/delivery-issue-reports/${reportId}/close`,
    headers, payload: { expected_version: 1 } })).statusCode, 404, 'no customer close route exists');
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { expected_version: 1 } })).statusCode, 409);
  const transition = { tenantId: 'tenant-a', environmentId: 'local', reportId, staffId: 'staff-a', expectedVersion: 1, idempotencyKey: 'claim-key' };
  const receivedDetail = await app.inject({ method: 'GET', url: `/v1/delivery-issue-reports/${reportId}`, headers });
  assert.equal(receivedDetail.json().can_close_review, false);
  assert.equal('closed_at' in receivedDetail.json().delivery_issue_report, false);
  await repository.claim(transition);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { expected_version: 2 } })).statusCode, 409);
  await repository.acknowledge({ ...transition, expectedVersion: 2, idempotencyKey: 'ack-key' });
  const assignedDetail = await app.inject({ method: 'GET', url: `/v1/delivery-issue-reports/${reportId}`, headers });
  assert.equal(assignedDetail.json().can_close_review, true);
  const otherStaffDetail = await app.inject({ method: 'GET', url: `/v1/delivery-issue-reports/${reportId}`,
    headers: { [DELIVERY_STAFF_ASSERTION_HEADER]: await staffAssertion('DELIVERY_AGENT', 'tenant-a', 'staff-b') } });
  assert.equal(otherStaffDetail.json().can_close_review, false);
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, [DELIVERY_STAFF_ASSERTION_HEADER]: await staffAssertion('DELIVERY_AGENT', 'tenant-a', 'staff-b') },
    payload: { expected_version: 3 } })).statusCode, 409);
  const closed = await app.inject({ method: 'POST', url, headers, payload: { expected_version: 3 } });
  assert.equal(closed.statusCode, 200);
  assert.equal(closed.headers['cache-control'], 'private, no-store');
  assert.equal(closed.json().delivery_issue_report.status, 'REVIEW_CLOSED');
  assert.equal(closed.json().delivery_issue_report.version, 4);
  assert.equal(closed.json().delivery_issue_report.closed_at, now.toISOString());
  assert.deepEqual((await app.inject({ method: 'POST', url, headers, payload: { expected_version: 3 } })).json(), closed.json());
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': 'other-key' }, payload: { expected_version: 4 } })).statusCode, 409);
  const detail = await app.inject({ method: 'GET', url: `/v1/delivery-issue-reports/${reportId}`, headers });
  assert.equal(detail.json().can_close_review, false);
  assert.equal(detail.json().audit_events[3].event_type, 'REPORT_REVIEW_CLOSED');
  const list = await app.inject({ method: 'GET', url: '/v1/delivery-issue-reports?status=REVIEW_CLOSED', headers });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().delivery_issue_reports.length, 1);
  for (const response of [
    await app.inject({ method: 'GET', url: `/internal/v1/delivery-issue-reports/${reportId}`, headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: await readAssertion(reportId) } }),
    await app.inject({ method: 'POST', url: '/internal/v1/delivery-issue-reports/replay', headers: { [DELIVERY_REPORT_ASSERTION_HEADER]: await replayAssertion(), 'idempotency-key': 'request-key' }, payload: body }),
  ]) {
    assert.equal(response.statusCode, 200);
    assert.equal('can_close_review' in response.json(), false);
    assert.equal(response.json().delivery_issue_report.status, 'REVIEW_CLOSED');
    assert.deepEqual(Object.keys(response.json().delivery_issue_report).sort(), ['category', 'created_at', 'order_reference', 'report_id', 'status', 'updated_at']);
  }
});
