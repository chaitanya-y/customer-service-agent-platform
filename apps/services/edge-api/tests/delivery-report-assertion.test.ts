import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { jwtVerify } from 'jose';

import { createDeliveryReportAssertionSigner } from '../src/delivery-report-assertion.js';

const secret = 'delivery-report-context-secret-1234567890';
const identity = {
  principalId: 'customer-2',
  customerId: 'customer-2',
  tenantId: 'tenant-local',
  environmentId: 'local',
};

test('create assertion binds customer, conversation, order, category, idempotency and body', async () => {
  const sign = createDeliveryReportAssertionSigner({
    secret,
    issuer: 'edge',
    audience: 'human-operations-delivery-report',
    now: () => new Date('2026-10-02T12:00:00.000Z'),
  });
  const token = await sign({
    purpose: 'delivery_issue_report_create',
    identity,
    conversationId: 'conversation-1',
    orderReference: 'ORDER1234',
    category: 'DAMAGED',
    idempotencyKey: 'delivery-create-1',
    requestId: 'request-1',
  });
  const { payload, protectedHeader } = await jwtVerify(
    token,
    new TextEncoder().encode(secret),
    {
      issuer: 'edge',
      audience: 'human-operations-delivery-report',
      typ: 'cso-delivery-report+jwt',
      currentDate: new Date('2026-10-02T12:00:30.000Z'),
    },
  );
  assert.equal(protectedHeader.alg, 'HS256');
  assert.equal(payload.purpose, 'delivery_issue_report_create');
  assert.equal(payload.tenantId, 'tenant-local');
  assert.equal(payload.environmentId, 'local');
  assert.equal(payload.subjectCustomerId, 'customer-2');
  assert.equal(payload.conversationId, 'conversation-1');
  assert.equal(payload.orderReference, 'ORDER1234');
  assert.equal(payload.category, 'DAMAGED');
  assert.equal(payload.idempotencyKey, 'delivery-create-1');
  assert.equal(payload.requestId, 'request-1');
  assert.equal(payload.bodySha256, createHash('sha256').update(
    JSON.stringify({ order_reference: 'ORDER1234', category: 'DAMAGED' }),
  ).digest('hex'));
  assert.equal(payload.exp! - payload.iat!, 60);
});

test('read assertion binds a customer to one report without create capability', async () => {
  const sign = createDeliveryReportAssertionSigner({
    secret,
    issuer: 'edge',
    audience: 'human-operations-delivery-report',
    now: () => new Date('2026-10-02T12:00:00.000Z'),
  });
  const token = await sign({
    purpose: 'delivery_issue_report_read',
    identity,
    reportId: 'report-1',
    requestId: 'request-2',
  });
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    issuer: 'edge', audience: 'human-operations-delivery-report',
    typ: 'cso-delivery-report+jwt',
    currentDate: new Date('2026-10-02T12:00:30.000Z'),
  });
  assert.equal(payload.purpose, 'delivery_issue_report_read');
  assert.equal(payload.reportId, 'report-1');
  assert.equal(payload.orderReference, undefined);
  assert.equal(payload.bodySha256, undefined);
});

test('replay assertion has a distinct purpose and binds the original body and key', async () => {
  const sign = createDeliveryReportAssertionSigner({
    secret, issuer: 'edge', audience: 'human-operations-delivery-report',
    now: () => new Date('2026-10-02T12:00:00.000Z'),
  });
  const token = await sign({
    purpose: 'delivery_issue_report_replay', identity,
    conversationId: 'conversation-1', orderReference: 'ORDER1234',
    category: 'DAMAGED', idempotencyKey: 'scoped-key-1', requestId: 'request-3',
  });
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    issuer: 'edge', audience: 'human-operations-delivery-report',
    typ: 'cso-delivery-report+jwt', currentDate: new Date('2026-10-02T12:00:30.000Z'),
  });
  assert.equal(payload.purpose, 'delivery_issue_report_replay');
  assert.equal(payload.subjectCustomerId, identity.customerId);
  assert.equal(payload.tenantId, identity.tenantId);
  assert.equal(payload.environmentId, identity.environmentId);
  assert.equal(payload.conversationId, 'conversation-1');
  assert.equal(payload.orderReference, 'ORDER1234');
  assert.equal(payload.category, 'DAMAGED');
  assert.equal(payload.idempotencyKey, 'scoped-key-1');
  assert.equal(payload.bodySha256, createHash('sha256').update(
    JSON.stringify({ order_reference: 'ORDER1234', category: 'DAMAGED' }),
  ).digest('hex'));
  assert.equal(payload.exp! - payload.iat!, 60);
  await assert.rejects(() => sign({
    purpose: 'delivery_issue_report_replay', identity: { ...identity, principalId: 'other' },
    conversationId: 'conversation-1', orderReference: 'ORDER1234',
    category: 'DAMAGED', idempotencyKey: 'scoped-key-1', requestId: 'request-3',
  }));
});

test('list assertion binds only customer scope and cannot carry create or read authority', async () => {
  const sign = createDeliveryReportAssertionSigner({
    secret, issuer: 'edge', audience: 'human-operations-delivery-report',
    now: () => new Date('2026-10-02T12:00:00.000Z'),
  });
  const token = await sign({ purpose: 'delivery_issue_report_list', identity, requestId: 'request-list-1' });
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    issuer: 'edge', audience: 'human-operations-delivery-report',
    typ: 'cso-delivery-report+jwt', currentDate: new Date('2026-10-02T12:00:30.000Z'),
  });
  assert.equal(payload.purpose, 'delivery_issue_report_list');
  assert.equal(payload.tenantId, identity.tenantId);
  assert.equal(payload.environmentId, identity.environmentId);
  assert.equal(payload.subjectCustomerId, identity.customerId);
  assert.equal(payload.requestId, 'request-list-1');
  for (const forbidden of ['conversationId', 'orderReference', 'category', 'idempotencyKey', 'bodySha256', 'reportId']) {
    assert.equal(payload[forbidden], undefined);
  }
  assert.equal(payload.exp! - payload.iat!, 60);
  await assert.rejects(() => sign({ purpose: 'delivery_issue_report_list',
    identity, requestId: 'request-list-1', reportId: 'forged' }));
});

test('signer refuses a non-self customer and invalid category', async () => {
  const sign = createDeliveryReportAssertionSigner({
    secret, issuer: 'edge', audience: 'human-operations-delivery-report',
  });
  await assert.rejects(() => sign({
    purpose: 'delivery_issue_report_create',
    identity: { ...identity, principalId: 'someone-else' },
    conversationId: 'conversation-1',
    orderReference: 'ORDER1234',
    category: 'DAMAGED',
    idempotencyKey: 'delivery-create-1',
    requestId: 'request-1',
  }));
  await assert.rejects(() => sign({
    purpose: 'delivery_issue_report_create',
    identity,
    conversationId: 'conversation-1',
    orderReference: 'ORDER1234',
    category: 'REFUND',
    idempotencyKey: 'delivery-create-1',
    requestId: 'request-1',
  }));
});
