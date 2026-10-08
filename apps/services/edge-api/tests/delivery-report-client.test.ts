import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type RequestListener, type Server } from 'node:http';
import test from 'node:test';

import {
  createDeliveryReportClient,
} from '../src/delivery-report-client.js';

const projection = {
  report_id: 'report-1',
  status: 'RECEIVED',
  category: 'DAMAGED',
  order_reference: 'ORDER1234',
  created_at: '2026-10-02T12:00:00.000Z',
  updated_at: '2026-10-02T12:00:00.000Z',
};

test('Gateway ownership check accepts only matching minimal projection', async () => {
  const requests: Request[] = [];
  const client = createDeliveryReportClient({
    gatewayBaseUrl: 'http://gateway.local',
    humanOperationsBaseUrl: 'http://human.local',
    fetcher: async (request) => {
      requests.push(request as Request);
      return Response.json({ schemaVersion: '1', reference: 'ORDER1234' });
    },
  });
  assert.equal(await client.verifyOwnedOrder('ORDER1234', 'gateway-assertion'), 'owned');
  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[0]?.url, 'http://gateway.local/internal/v1/delivery-order-ownership/ORDER1234');
  assert.equal(requests[0]?.headers.get('x-cso-context-assertion'), 'gateway-assertion');
});

test('Gateway ownership masks missing orders and fails closed on mismatched or rich data', async () => {
  let response: Response = Response.json({ error: { code: 'order_not_found' } }, { status: 404 });
  const client = createDeliveryReportClient({
    gatewayBaseUrl: 'http://gateway.local',
    humanOperationsBaseUrl: 'http://human.local',
    fetcher: async () => response,
  });
  assert.equal(await client.verifyOwnedOrder('ORDER1234', 'assertion'), 'not_found');
  response = Response.json({ schemaVersion: '1', reference: 'OTHER1234' });
  assert.equal(await client.verifyOwnedOrder('ORDER1234', 'assertion'), 'unavailable');
  response = Response.json({ schemaVersion: '1', reference: 'ORDER1234', payment: 'private' });
  assert.equal(await client.verifyOwnedOrder('ORDER1234', 'assertion'), 'unavailable');
});

test('Human Operations create keeps the same idempotency key and accepts only safe receipt', async () => {
  const requests: Request[] = [];
  const client = createDeliveryReportClient({
    gatewayBaseUrl: 'http://gateway.local',
    humanOperationsBaseUrl: 'http://human.local',
    fetcher: async (request) => {
      requests.push(request as Request);
      return Response.json({ delivery_issue_report: projection }, { status: 201 });
    },
  });
  const result = await client.createReport({
    body: { order_reference: 'ORDER1234', category: 'DAMAGED' },
    assertion: 'create-assertion', idempotencyKey: 'delivery-create-1',
  });
  assert.deepEqual(result, { kind: 'created', report: projection });
  assert.equal(requests[0]?.url, 'http://human.local/internal/v1/delivery-issue-reports');
  assert.equal(requests[0]?.headers.get('x-cso-delivery-report-assertion'), 'create-assertion');
  assert.equal(requests[0]?.headers.get('idempotency-key'), 'delivery-create-1');
  assert.deepEqual(await requests[0]?.json(), { order_reference: 'ORDER1234', category: 'DAMAGED' });
});

test('Human Operations uncertain or unsafe response cannot claim a report was received', async () => {
  let response = Response.json({ delivery_issue_report: { ...projection, staff_note: 'private' } }, { status: 201 });
  const client = createDeliveryReportClient({
    gatewayBaseUrl: 'http://gateway.local', humanOperationsBaseUrl: 'http://human.local',
    fetcher: async () => response,
  });
  const input = { body: { order_reference: 'ORDER1234', category: 'DAMAGED' } as const,
    assertion: 'assertion', idempotencyKey: 'delivery-create-1' };
  assert.deepEqual(await client.createReport(input), { kind: 'unconfirmed' });
  response = Response.json({ error: { code: 'down' } }, { status: 503 });
  assert.deepEqual(await client.createReport(input), { kind: 'unconfirmed' });
  response = Response.json({ error: { code: 'idempotency_conflict' } }, { status: 409 });
  assert.deepEqual(await client.createReport(input), { kind: 'conflict' });
});

test('customer report read accepts only a safe projection', async () => {
  const client = createDeliveryReportClient({
    gatewayBaseUrl: 'http://gateway.local', humanOperationsBaseUrl: 'http://human.local',
    fetcher: async () => Response.json({ delivery_issue_report: projection }),
  });
  assert.deepEqual(await client.getReport('report-1', 'read-assertion'), {
    kind: 'found', report: projection,
  });
});

test('review-closed delivery reports remain customer-safe on read, list, and replay', async () => {
  const closed = { ...projection, status: 'REVIEW_CLOSED' };
  const input = { body: { order_reference: 'ORDER1234', category: 'DAMAGED' } as const,
    assertion: 'replay-assertion', idempotencyKey: 'scoped-key-1' };
  let payload: unknown = { delivery_issue_report: closed };
  const client = createDeliveryReportClient({
    gatewayBaseUrl: 'http://gateway.local', humanOperationsBaseUrl: 'http://human.local',
    fetcher: async () => Response.json(payload),
  });
  assert.deepEqual(await client.getReport('report-1', 'read-assertion'), { kind: 'found', report: closed });
  assert.deepEqual(await client.replayReport(input), { kind: 'found', report: closed });
  payload = { delivery_issue_reports: [closed], has_more: false };
  assert.deepEqual(await client.listReports('list-assertion'), { kind: 'found', history: payload });
  payload = { delivery_issue_report: { ...closed, assigned_staff_id: 'staff-1' } };
  assert.deepEqual(await client.getReport('report-1', 'read-assertion'), { kind: 'unavailable' });
});

test('replay posts the original body and key to Human Operations and accepts only a strict receipt', async () => {
  const requests: Request[] = [];
  let response = Response.json({ delivery_issue_report: projection });
  const client = createDeliveryReportClient({
    gatewayBaseUrl: 'http://gateway.local', humanOperationsBaseUrl: 'http://human.local',
    fetcher: async (request) => { requests.push(request as Request); return response; },
  });
  const input = { body: { order_reference: 'ORDER1234', category: 'DAMAGED' } as const,
    assertion: 'replay-assertion', idempotencyKey: 'scoped-key-1' };
  assert.deepEqual(await client.replayReport(input), { kind: 'found', report: projection });
  assert.equal(requests[0]?.url, 'http://human.local/internal/v1/delivery-issue-reports/replay');
  assert.equal(requests[0]?.method, 'POST');
  assert.equal(requests[0]?.headers.get('x-cso-delivery-report-assertion'), 'replay-assertion');
  assert.equal(requests[0]?.headers.get('idempotency-key'), 'scoped-key-1');
  assert.deepEqual(await requests[0]?.json(), input.body);
  response = Response.json({ error: { code: 'delivery_report_not_found' } }, { status: 404 });
  assert.deepEqual(await client.replayReport(input), { kind: 'not_found' });
  response = Response.json({ error: { code: 'delivery_report_conflict' } }, { status: 409 });
  assert.deepEqual(await client.replayReport(input), { kind: 'conflict' });
  response = Response.json({ delivery_issue_report: { ...projection, staff_note: 'private' } });
  assert.deepEqual(await client.replayReport(input), { kind: 'unavailable' });
  response = Response.json({ delivery_issue_report: { ...projection, order_reference: 'OTHER' } });
  assert.deepEqual(await client.replayReport(input), { kind: 'unavailable' });
});

test('customer list uses read-only Human Operations endpoint and validates bounded safe order', async () => {
  const requests: Request[] = [];
  let response = Response.json({ delivery_issue_reports: [
    { ...projection, report_id: 'report-2', updated_at: '2026-10-02T13:00:00.000Z' },
    projection,
  ], has_more: false });
  const client = createDeliveryReportClient({
    gatewayBaseUrl: 'http://gateway.local', humanOperationsBaseUrl: 'http://human.local',
    fetcher: async (request) => { requests.push(request as Request); return response; },
  });
  const result = await client.listReports('list-assertion');
  assert.equal(result.kind, 'found');
  assert.equal(result.kind === 'found' && result.history.delivery_issue_reports.length, 2);
  assert.equal(requests[0]?.url, 'http://human.local/internal/v1/delivery-issue-reports');
  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[0]?.headers.get('x-cso-delivery-report-assertion'), 'list-assertion');
  assert.equal(requests[0]?.body, null);
  for (const invalid of [
    { delivery_issue_reports: [{ ...projection, private_note: 'private' }], has_more: false },
    { delivery_issue_reports: [projection, projection], has_more: false },
    { delivery_issue_reports: [projection, { ...projection, report_id: 'report-2', updated_at: '2026-10-02T13:00:00.000Z' }], has_more: false },
    { delivery_issue_reports: [projection], has_more: true },
    { delivery_issue_reports: Array.from({ length: 11 }, (_, index) => ({ ...projection, report_id: `report-${index}` })), has_more: false },
    { delivery_issue_reports: [{ ...projection, status: 'RESOLVED' }], has_more: false },
  ]) {
    response = Response.json(invalid);
    assert.deepEqual(await client.listReports('list-assertion'), { kind: 'unavailable' });
  }
  response = Response.json({ error: { code: 'down' } }, { status: 503 });
  assert.deepEqual(await client.listReports('list-assertion'), { kind: 'unavailable' });
});

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

for (const operation of ['ownership', 'create', 'read', 'replay', 'list'] as const) {
  test(`${operation} rejects a cross-origin 307 without forwarding assertions or body`, async (t) => {
    const redirectedRequests: { headers: object; body: string }[] = [];
    const receiver = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        redirectedRequests.push({ headers: request.headers, body });
        response.writeHead(operation === 'create' ? 201 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(operation === 'ownership'
          ? { schemaVersion: '1', reference: 'ORDER1234' }
          : { delivery_issue_report: projection }));
      });
    });
    const receivedRequests: { method: string | undefined; assertion: string | string[] | undefined; body: string }[] = [];
    let destination = '';
    const redirect: RequestListener = (request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        receivedRequests.push({
          method: request.method,
          assertion: request.headers[operation === 'ownership'
            ? 'x-cso-context-assertion' : 'x-cso-delivery-report-assertion'],
          body,
        });
        response.writeHead(307, { location: `${destination}/redirect-target` });
        response.end();
      });
    };
    const upstream = createServer(redirect);
    t.after(async () => {
      await Promise.all([upstream, receiver].map(async (server) => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }));
    });
    destination = await listen(receiver);
    const baseUrl = await listen(upstream);
    assert.notEqual(baseUrl, destination);
    const client = createDeliveryReportClient({
      gatewayBaseUrl: baseUrl,
      humanOperationsBaseUrl: baseUrl,
    });
    const assertion = 'synthetic-redirect-test-assertion';
    const result = operation === 'ownership'
      ? await client.verifyOwnedOrder('ORDER1234', assertion)
      : operation === 'create'
        ? await client.createReport({
            body: { order_reference: 'ORDER1234', category: 'DAMAGED' },
            assertion, idempotencyKey: 'synthetic-idempotency-key',
          })
        : operation === 'replay'
          ? await client.replayReport({
              body: { order_reference: 'ORDER1234', category: 'DAMAGED' },
              assertion, idempotencyKey: 'synthetic-idempotency-key',
            })
          : operation === 'list'
            ? await client.listReports(assertion)
            : await client.getReport('report-1', assertion);

    assert.deepEqual(receivedRequests, [{
      method: operation === 'create' || operation === 'replay' ? 'POST' : 'GET',
      assertion,
      body: operation === 'create' || operation === 'replay'
        ? '{"order_reference":"ORDER1234","category":"DAMAGED"}' : '',
    }]);
    assert.deepEqual(redirectedRequests, [], 'redirect destination must receive no assertion or body');
    assert.deepEqual(result, operation === 'ownership'
      ? 'unavailable' : { kind: operation === 'create' ? 'unconfirmed' : 'unavailable' });
  });
}
