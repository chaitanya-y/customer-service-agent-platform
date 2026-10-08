import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const edgeBase = process.env.CSO_LOCAL_EDGE_BASE_URL ?? 'http://127.0.0.1:3000';
const operationsBase = process.env.CSO_LOCAL_HUMAN_OPERATIONS_BASE_URL ?? 'http://127.0.0.1:3003';
const customerToken = process.env.CSO_LOCAL_CUSTOMER_TOKEN;
const supportToken = process.env.CSO_LOCAL_SUPPORT_STAFF_TOKEN;

if (!customerToken || !supportToken) {
  throw new Error('Load ignored local customer and support-staff tokens before this backend-only check.');
}

async function request(base, path, auth, method = 'GET', body, key) {
  const response = await fetch(new URL(path, base), {
    method,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: 'application/json',
      ...(auth === 'customer'
        ? { authorization: `Bearer ${customerToken}` }
        : { 'x-cso-support-staff-assertion': supportToken }),
      ...(body === undefined ? {} : {
        'content-type': 'application/json',
        'idempotency-key': key ?? `delivery-recovery-${randomUUID()}`,
      }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

function requireStatus(result, expected, step) {
  assert.equal(result.status, expected, `${step}: HTTP ${result.status} ${result.payload?.error?.code ?? ''}`);
  return result.payload;
}

const references = requireStatus(
  await request(edgeBase, '/v1/account/recent-order-references', 'customer'),
  200,
  'find owned order',
);
assert.equal(references.schemaVersion, '1');
const orderReference = references.orders?.[0]?.reference;
assert.match(orderReference ?? '', /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const conversation = requireStatus(
  await request(edgeBase, '/v1/conversations', 'customer', 'POST', {}),
  201,
  'create conversation',
);
const conversationId = conversation.conversation_id;
assert.match(conversationId ?? '', /^[0-9a-f-]{36}$/i);
assert.equal(conversation.control_version, 1);

const body = { order_reference: orderReference, category: 'DELAYED' };
const reportKey = `delivery-recovery-${randomUUID()}`;
// Treat the create response as lost until after replay; no second create is sent.
const first = requireStatus(
  await request(edgeBase, `/v1/conversations/${conversationId}/delivery-issue-reports`, 'customer', 'POST', body, reportKey),
  201,
  'create delivery report',
);
const firstReportId = first.delivery_issue_report?.report_id;
assert.match(firstReportId ?? '', /^delivery-[0-9a-f-]{36}$/i);

const handoff = requireStatus(
  await request(edgeBase, `/v1/conversations/${conversationId}/handoff`, 'customer', 'POST', { expected_control_version: 1 }),
  200,
  'handoff',
);
const handoffSessionId = handoff.handoff_session_id;
assert.match(handoffSessionId ?? '', /^[0-9a-f-]{36}$/i);
requireStatus(
  await request(operationsBase, `/v1/support-chats/${conversationId}/claim`, 'staff', 'POST', {
    handoffSessionId, expectedControlVersion: 2,
  }),
  200,
  'staff claim',
);
requireStatus(
  await request(operationsBase, `/v1/support-chats/${conversationId}/close`, 'staff', 'POST', {
    handoffSessionId, expectedControlVersion: 3,
  }),
  200,
  'close conversation',
);

const replay = requireStatus(
  await request(edgeBase, `/v1/conversations/${conversationId}/delivery-issue-reports/replay`, 'customer', 'POST', body, reportKey),
  200,
  'replay closed-conversation receipt',
);
assert.equal(replay.delivery_issue_report?.report_id, firstReportId);
assert.equal(replay.delivery_issue_report?.order_reference, orderReference);
assert.equal(replay.delivery_issue_report?.status, 'RECEIVED');
assert.equal(Object.keys(replay.delivery_issue_report ?? {}).length, 6);

const wrongBody = await request(edgeBase, `/v1/conversations/${conversationId}/delivery-issue-reports/replay`, 'customer', 'POST', {
  ...body, category: 'WRONG',
}, reportKey);
assert.equal(wrongBody.status, 409, 'changed body cannot claim original receipt');
const missing = await request(edgeBase, `/v1/conversations/${conversationId}/delivery-issue-reports/replay`, 'customer', 'POST', body,
  `delivery-recovery-${randomUUID()}`);
assert.equal(missing.status, 404, 'missing key must not create a report');

const current = requireStatus(
  await request(edgeBase, `/v1/delivery-issue-reports/${encodeURIComponent(firstReportId)}`, 'customer'),
  200,
  'owner readback',
);
assert.equal(current.delivery_issue_report?.report_id, firstReportId);

console.log(JSON.stringify({
  result: 'passed', mode: 'backend-only', conversationId, reportId: firstReportId,
  checks: ['owner-bound order lookup', 'single create', 'closed-conversation replay', 'changed-body conflict', 'missing-key no-write', 'owner readback'],
}));
