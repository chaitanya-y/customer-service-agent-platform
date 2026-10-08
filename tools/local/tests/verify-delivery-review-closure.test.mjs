import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSmokeArguments, runDeliveryReviewClosureSmoke } from '../verify-delivery-review-closure.mjs';

const orderReference = 'TESTORDER123';
const conversationId = '11111111-1111-4111-8111-111111111111';
const reportId = 'delivery-22222222-2222-4222-8222-222222222222';
const customerReport = (status, updatedAt = '2026-10-02T12:00:00.000Z') => ({
  report_id: reportId, order_reference: orderReference, category: 'DELAYED', status,
  created_at: '2026-10-02T12:00:00.000Z', updated_at: updatedAt,
});
const staffReport = (status, version) => ({
  ...customerReport(status), version, assigned_staff_id: 'staff-private',
  ...(status === 'REVIEW_CLOSED' ? { closed_at: '2026-10-02T12:05:00.000Z' } : {}),
});

function mockJourney({ owned = true, readback = customerReport('REVIEW_CLOSED'), omitClosedAt = false } = {}) {
  const calls = [];
  const replies = owned ? [
    [200, { schemaVersion: '1', orders: [{ reference: orderReference }] }],
    [201, { conversation_id: conversationId, status: 'OPEN', control_version: 1 }],
    [201, { delivery_issue_report: customerReport('RECEIVED') }],
    [200, { delivery_issue_report: staffReport('CLAIMED', 2) }],
    [200, { delivery_issue_report: staffReport('ACKNOWLEDGED', 3) }],
    [200, { delivery_issue_report: { ...staffReport('REVIEW_CLOSED', 4), ...(omitClosedAt ? { closed_at: undefined } : {}) } }],
    [200, { delivery_issue_report: { ...staffReport('REVIEW_CLOSED', 4), ...(omitClosedAt ? { closed_at: undefined } : {}) } }],
    [409, { error: { code: 'delivery_report_conflict' } }],
    [200, { delivery_issue_report: readback }],
  ] : [[200, { schemaVersion: '1', orders: [{ reference: 'OTHERORDER' }] }]];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const reply = replies.shift();
      assert.ok(reply, 'unexpected extra request');
      return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
    },
  };
}

test('requires explicit run guard and one safe order reference', () => {
  assert.deepEqual(parseSmokeArguments(['--run', `--order-reference=${orderReference}`]), { orderReference });
  for (const args of [[], [`--order-reference=${orderReference}`], ['--run'],
    ['--run', '--order-reference='], ['--run', '--order-reference=BAD/ORDER'],
    ['--run', `--order-reference=${orderReference}`, '--extra']]) {
    assert.throws(() => parseSmokeArguments(args), /--run|order reference/);
  }
});

test('performs one guarded report, staff transitions, idempotency checks, and six-field customer readback', async () => {
  const { calls, fetchImpl } = mockJourney();
  const result = await runDeliveryReviewClosureSmoke({
    orderReference, customerToken: 'private-customer', staffToken: 'private-staff', fetchImpl,
  });
  assert.equal(result.status, 'PASSED');
  assert.equal(result.reportId, reportId);
  assert.match(result.meaning, /does not confirm.*fixed.*remedy/i);
  assert.deepEqual(calls.map(({ url, init }) => [new URL(url).origin, new URL(url).pathname, init.method]), [
    ['http://127.0.0.1:3000', '/v1/account/recent-order-references', 'GET'],
    ['http://127.0.0.1:3000', '/v1/conversations', 'POST'],
    ['http://127.0.0.1:3000', `/v1/conversations/${conversationId}/delivery-issue-reports`, 'POST'],
    ['http://127.0.0.1:3003', `/v1/delivery-issue-reports/${reportId}/claim`, 'POST'],
    ['http://127.0.0.1:3003', `/v1/delivery-issue-reports/${reportId}/acknowledge`, 'POST'],
    ['http://127.0.0.1:3003', `/v1/delivery-issue-reports/${reportId}/close`, 'POST'],
    ['http://127.0.0.1:3003', `/v1/delivery-issue-reports/${reportId}/close`, 'POST'],
    ['http://127.0.0.1:3003', `/v1/delivery-issue-reports/${reportId}/close`, 'POST'],
    ['http://127.0.0.1:3000', `/v1/delivery-issue-reports/${reportId}`, 'GET'],
  ]);
  assert.deepEqual(JSON.parse(calls[2].init.body), { order_reference: orderReference, category: 'DELAYED' });
  assert.deepEqual(calls.slice(3, 8).map(({ init }) => JSON.parse(init.body)), [
    { expected_version: 1 }, { expected_version: 2 }, { expected_version: 3 },
    { expected_version: 3 }, { expected_version: 3 },
  ]);
  assert.equal(calls[5].init.headers['idempotency-key'], calls[6].init.headers['idempotency-key']);
  assert.notEqual(calls[6].init.headers['idempotency-key'], calls[7].init.headers['idempotency-key']);
  assert.ok(calls.every(({ init }) => init.redirect === 'error' && init.signal));
  assert.ok(calls.slice(0, 3).concat(calls.slice(8)).every(({ init }) => init.headers.authorization === 'Bearer private-customer'));
  assert.ok(calls.slice(3, 8).every(({ init }) => init.headers['x-cso-delivery-staff-assertion'] === 'private-staff'));
});

test('stops before writes for an order absent from owned references', async () => {
  const { calls, fetchImpl } = mockJourney({ owned: false });
  await assert.rejects(runDeliveryReviewClosureSmoke({
    orderReference, customerToken: 'private-customer', staffToken: 'private-staff', fetchImpl,
  }), /owned order reference/);
  assert.equal(calls.length, 1);
});

test('rejects customer readback with internal fields and sanitizes transport failures', async () => {
  const { fetchImpl } = mockJourney({ readback: { ...customerReport('REVIEW_CLOSED'), assigned_staff_id: 'private-staff' } });
  await assert.rejects(runDeliveryReviewClosureSmoke({
    orderReference, customerToken: 'private-customer', staffToken: 'private-staff', fetchImpl,
  }), /six public fields/);
  await assert.rejects(runDeliveryReviewClosureSmoke({
    orderReference, customerToken: 'private-customer', staffToken: 'private-staff',
    fetchImpl: async () => { throw new Error('private-customer private-staff'); },
  }), error => { assert.doesNotMatch(error.message, /private-customer|private-staff/); return true; });
});

test('rejects closure without its authoritative timestamp', async () => {
  const { fetchImpl } = mockJourney({ omitClosedAt: true });
  await assert.rejects(runDeliveryReviewClosureSmoke({
    orderReference, customerToken: 'private-customer', staffToken: 'private-staff', fetchImpl,
  }), /closed_at/);
});
