#!/usr/bin/env node
/** Opt-in local backend smoke. Persists one disposable DELAYED report; no chat/model, refund, or commerce mutation. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const edgeBase = 'http://127.0.0.1:3000';
const operationsBase = 'http://127.0.0.1:3003';
const reportFields = ['category', 'created_at', 'order_reference', 'report_id', 'status', 'updated_at'];
const noRemedyMeaning = 'Review closed does not confirm the delivery issue was fixed or that a remedy was provided.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reportIdPattern = /^delivery-[0-9a-f-]{36}$/i;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseSmokeArguments(args) {
  const references = args.filter(arg => arg.startsWith('--order-reference='));
  requireCondition(args.length === 2 && args.includes('--run') && references.length === 1,
    'Use --run --order-reference=OWNED_TEST_ORDER.');
  const orderReference = references[0].slice('--order-reference='.length);
  requireCondition(orderReference.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(orderReference),
    'Provide one safe owned order reference.');
  return { orderReference };
}

/** @param {{orderReference: string, customerToken: string, staffToken: string, fetchImpl?: typeof fetch}} input */
export async function runDeliveryReviewClosureSmoke({ orderReference, customerToken, staffToken, fetchImpl = fetch }) {
  parseSmokeArguments(['--run', `--order-reference=${orderReference}`]);
  requireCondition(typeof customerToken === 'string' && customerToken.length > 0,
    'CSO_LOCAL_CUSTOMER_TOKEN is required.');
  requireCondition(typeof staffToken === 'string' && staffToken.length > 0,
    'CSO_LOCAL_DELIVERY_STAFF_TOKEN is required.');

  async function request(base, path, auth, method = 'GET', body, key) {
    const origin = base === edgeBase ? 'Edge' : 'Human Operations';
    let response;
    try {
      response = await fetchImpl(new URL(path, base), {
        method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
        headers: {
          accept: 'application/json',
          ...(auth === 'customer'
            ? { authorization: `Bearer ${customerToken}` }
            : { 'x-cso-delivery-staff-assertion': staffToken }),
          ...(body === undefined ? {} : {
            'content-type': 'application/json', 'idempotency-key': key,
          }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`${origin} ${method} request failed.`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`${origin} ${method} returned invalid JSON.`);
    }
    return { status: response.status, payload };
  }

  function expectStatus(result, expected, step) {
    requireCondition(result.status === expected, `${step} returned HTTP ${result.status}.`);
    return result.payload;
  }

  function checkStaffReport(result, status, version, step, reportId) {
    const report = expectStatus(result, 200, step)?.delivery_issue_report;
    requireCondition(report?.report_id === reportId && report?.order_reference === orderReference
      && report?.category === 'DELAYED' && report?.status === status && report?.version === version,
    `${step} did not return the expected report state.`);
    requireCondition(status === 'REVIEW_CLOSED'
      ? typeof report.closed_at === 'string' && Number.isFinite(Date.parse(report.closed_at))
      : !Object.hasOwn(report, 'closed_at'),
    `${step} did not return the expected closed_at state.`);
    return report;
  }

  // This read-only guard avoids even creating a conversation for an unlisted order.
  const references = expectStatus(await request(edgeBase, '/v1/account/recent-order-references', 'customer'),
    200, 'Owned-order lookup');
  requireCondition(references?.schemaVersion === '1' && Array.isArray(references.orders)
    && references.orders.some(order => order?.reference === orderReference),
  'Provide an owned order reference returned by the local account lookup.');

  const conversation = expectStatus(await request(edgeBase, '/v1/conversations', 'customer', 'POST', {},
    `delivery-closure-${randomUUID()}`), 201, 'Conversation create');
  const conversationId = conversation?.conversation_id;
  requireCondition(uuid.test(conversationId) && conversation?.status === 'OPEN',
    'Edge did not create one open conversation.');

  const created = expectStatus(await request(edgeBase,
    `/v1/conversations/${conversationId}/delivery-issue-reports`, 'customer', 'POST',
    { order_reference: orderReference, category: 'DELAYED' }, `delivery-closure-${randomUUID()}`),
  201, 'Delivery report create')?.delivery_issue_report;
  const reportId = created?.report_id;
  requireCondition(reportIdPattern.test(reportId) && created?.status === 'RECEIVED'
    && created?.order_reference === orderReference && created?.category === 'DELAYED',
  'Edge did not create one received delivery report.');

  const path = `/v1/delivery-issue-reports/${encodeURIComponent(reportId)}`;
  for (const [action, status, version, expectedVersion] of [
    ['claim', 'CLAIMED', 2, 1],
    ['acknowledge', 'ACKNOWLEDGED', 3, 2],
  ]) {
    checkStaffReport(await request(operationsBase, `${path}/${action}`, 'staff', 'POST',
      { expected_version: expectedVersion }, `delivery-closure-${randomUUID()}`),
    status, version, `Staff ${action}`, reportId);
  }

  const closeKey = `delivery-closure-${randomUUID()}`;
  const closeBody = { expected_version: 3 };
  const closed = checkStaffReport(await request(operationsBase, `${path}/close`, 'staff', 'POST', closeBody, closeKey),
    'REVIEW_CLOSED', 4, 'Staff close', reportId);
  const replay = checkStaffReport(await request(operationsBase, `${path}/close`, 'staff', 'POST', closeBody, closeKey),
    'REVIEW_CLOSED', 4, 'Same-key close replay', reportId);
  requireCondition(JSON.stringify(replay) === JSON.stringify(closed), 'Same-key close replay changed the report.');
  const stale = await request(operationsBase, `${path}/close`, 'staff', 'POST', closeBody,
    `delivery-closure-${randomUUID()}`);
  expectStatus(stale, 409, 'Stale different-key close');
  requireCondition(stale.payload?.error?.code === 'delivery_report_conflict',
    'Stale different-key close did not report a delivery conflict.');

  const readback = expectStatus(await request(edgeBase, path, 'customer'), 200,
    'Customer report readback')?.delivery_issue_report;
  requireCondition(readback && Object.keys(readback).sort().join('|') === reportFields.join('|'),
    'Customer readback did not contain exactly six public fields.');
  requireCondition(readback.report_id === reportId && readback.order_reference === orderReference
    && readback.category === 'DELAYED' && readback.status === 'REVIEW_CLOSED'
    && typeof readback.created_at === 'string' && typeof readback.updated_at === 'string',
  'Customer readback did not confirm review closure.');

  return { status: 'PASSED', mode: 'local-backend-only', conversationId, reportId, meaning: noRemedyMeaning };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Usage: node tools/local/verify-delivery-review-closure.mjs --run --order-reference=OWNED_TEST_ORDER');
  } else {
    try {
      requireCondition(Number(process.versions.node.split('.')[0]) === 24, 'Use Node.js 24 for this smoke check.');
      const { orderReference } = parseSmokeArguments(process.argv.slice(2));
      console.log(JSON.stringify(await runDeliveryReviewClosureSmoke({ orderReference,
        customerToken: process.env.CSO_LOCAL_CUSTOMER_TOKEN,
        staffToken: process.env.CSO_LOCAL_DELIVERY_STAFF_TOKEN })));
    } catch (error) {
      // Never print response bodies, headers, tokens, or exception stacks.
      console.error(error instanceof Error ? error.message : 'Delivery review closure smoke failed.');
      process.exitCode = 1;
    }
  }
}
