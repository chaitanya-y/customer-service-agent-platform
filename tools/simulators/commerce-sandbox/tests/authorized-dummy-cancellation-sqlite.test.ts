import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  bootstrapWorker, CustomerService, ProductService, ProductVariantService, PaymentMethodService,
  OrderService, Order, OrderLine, Payment, StockLevel, StockMovementService, RequestContextService,
  RequestContext, TransactionalConnection, dummyPaymentHandler, DefaultLogger, LogLevel, Zone, Channel,
  isGraphQlErrorResult, LanguageCode, CurrencyCode, VendureWorker,
} from '@vendure/core';
import { ZeroTotalCancellationMarker1760000000000 } from '../src/migrations/1760000000000-ZeroTotalCancellationMarker';
import { ZeroTotalCancellationScope1760000000001 } from '../src/migrations/1760000000001-ZeroTotalCancellationScope';
import { AuthorizedDummyCancellationPayment1760000000002 } from '../src/migrations/1760000000002-AuthorizedDummyCancellationPayment';
import { AuthorizedDummyCancellationService } from '../src/plugins/authorized-dummy-cancellation/service';

let worker: VendureWorker;
let connection: TransactionalConnection;
let ctx: RequestContext;
let orders: OrderService;
let methods: PaymentMethodService;
let methodCode: string;

before(async () => {
  // Real Vendure services, entirely disposable in-memory SQLite; no running simulator DB/config.
  worker = await bootstrapWorker({
    logger: new DefaultLogger({ level: LogLevel.Error }),
    dbConnectionOptions: { type: 'better-sqlite3', database: ':memory:', synchronize: true },
    authOptions: { superadminCredentials: { identifier: 'isolated-test', password: 'isolated-test-password' } },
    paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] },
  });
  connection = worker.app.get(TransactionalConnection);
  ctx = await worker.app.get(RequestContextService).create({ apiType: 'admin' });
  const zone = await connection.getRepository(ctx, Zone).save(new Zone({ name: 'Isolated zone', members: [] }));
  await connection.getRepository(ctx, Channel).update(ctx.channelId, { defaultTaxZone: zone, defaultShippingZone: zone });
  const channel = await connection.getRepository(ctx, Channel).findOneOrFail({ where: { id: ctx.channelId }, relations: ['defaultTaxZone', 'defaultShippingZone'] });
  ctx = await worker.app.get(RequestContextService).create({ apiType: 'admin', channelOrToken: channel });
  orders = worker.app.get(OrderService);
  methods = worker.app.get(PaymentMethodService);
  const runner = { query: (sql: string) => connection.rawConnection.query(sql) };
  await new ZeroTotalCancellationMarker1760000000000().up(runner);
  await new ZeroTotalCancellationScope1760000000001().up(runner);
  await new AuthorizedDummyCancellationPayment1760000000002().up(runner);
  methodCode = 'locally-authorized';
  await methods.create(ctx, {
    code: methodCode, enabled: true,
    handler: { code: dummyPaymentHandler.code, arguments: [{ name: 'automaticSettle', value: 'false' }] },
    translations: [{ languageCode: LanguageCode.en, name: 'Isolated dummy', description: '' }],
  });
});
after(async () => { await worker?.app.close(); });

async function fixture(fault?: 'payment' | 'order', afterPayment?: () => Promise<void>) {
  const code = randomUUID();
  const customer = await worker.app.get(CustomerService).create(ctx, { firstName: 'Isolated', lastName: 'Fixture', emailAddress: `${code}@example.invalid` });
  assert.ok(!isGraphQlErrorResult(customer));
  const product = await worker.app.get(ProductService).create(ctx, { translations: [{ languageCode: LanguageCode.en, name: code, slug: code, description: '' }] });
  const [variant] = await worker.app.get(ProductVariantService).create(ctx, [{
    productId: product.id, sku: code, price: 1500, stockOnHand: 10, trackInventory: 'TRUE' as never,
    translations: [{ languageCode: LanguageCode.en, name: code }],
  }]);
  assert.ok(variant);
  const order = await connection.getRepository(ctx, Order).save(new Order({
    code, type: 'Regular' as never, state: 'PaymentAuthorized', active: false, orderPlacedAt: new Date(),
    customer, channels: [ctx.channel], currencyCode: CurrencyCode.USD, couponCodes: [],
    shippingAddress: {}, billingAddress: {}, subTotal: 1500, subTotalWithTax: 1500, shipping: 0, shippingWithTax: 0,
  }));
  const line = await connection.getRepository(ctx, OrderLine).save(new OrderLine({
    order, productVariant: variant, taxCategoryId: variant.taxCategoryId, quantity: 1, orderPlacedQuantity: 1,
    initialListPrice: 1500, listPrice: 1500, listPriceIncludesTax: false, adjustments: [], taxLines: [],
  }));
  const payment = await connection.getRepository(ctx, Payment).save(new Payment({
    order, method: methodCode, amount: 1500, state: 'Authorized', metadata: {}, transactionId: code,
  }));
  const loaded = await orders.findOne(ctx, order.id, ['lines', 'lines.productVariant']);
  assert.ok(loaded);
  await worker.app.get(StockMovementService).createAllocationsForOrder(ctx, loaded);
  const intercepted = new Proxy(orders, {
    get(target, property) {
      if (property === 'cancelPayment' || property === 'cancelOrder') return async (...args: unknown[]) => {
        const result = await (target[property] as Function).apply(target, args);
        if (property === 'cancelPayment' && afterPayment) await afterPayment();
        if ((fault === 'payment' && property === 'cancelPayment') || (fault === 'order' && property === 'cancelOrder')) throw new Error(`INJECTED_AFTER_${fault}`);
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const service = new AuthorizedDummyCancellationService(connection, intercepted, methods);
  const facts = await service.getFacts(ctx, String(order.id));
  assert.ok(facts?.eligible, 'Fixture must be eligible before testing cancellation');
  const input = {
    operationId: randomUUID(), tenantId: 'isolated', environmentId: 'test', customerId: String(customer.id),
    orderId: String(order.id), orderReference: code, paymentId: String(payment.id), expectedFactsDigest: facts.digest,
    workflowId: randomUUID(), previewId: randomUUID(), previewExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    policyVersion: 'AUTHORIZED_DUMMY_V1', idempotencyKey: randomUUID(),
  };
  return { service, input, line, variant, payment };
}

async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    order: await connection.rawConnection.query('SELECT state,active,subTotal,subTotalWithTax FROM "order" WHERE id = ?', [f.input.orderId]),
    line: await connection.rawConnection.query('SELECT quantity,orderPlacedQuantity FROM order_line WHERE id = ?', [f.line.id]),
    payment: await connection.rawConnection.query('SELECT state,metadata FROM payment WHERE id = ?', [f.payment.id]),
    stock: await connection.getRepository(ctx, StockLevel).find({ where: { productVariantId: f.variant.id } }),
    movements: await connection.rawConnection.query('SELECT * FROM stock_movement WHERE productVariantId = ? ORDER BY id', [f.variant.id]),
    history: await connection.rawConnection.query('SELECT * FROM history_entry WHERE orderId = ? ORDER BY id', [f.input.orderId]),
    marker: await f.service.getMarker(ctx, f.input.operationId),
  };
}

for (const fault of ['payment', 'order'] as const) test(`real SQLite rolls back payment, order, stock, history and marker after ${fault} cancellation fault`, async () => {
  const f = await fixture(fault);
  const initial = await snapshot(f);
  assert.equal(initial.stock[0]!.stockAllocated, 1);
  await assert.rejects(f.service.cancel(ctx, f.input), new RegExp(`INJECTED_AFTER_${fault}`));
  assert.deepEqual(await snapshot(f), initial);
});

test('real provider cancellation persists both final states and exact replay adds no stock/history mutation', async () => {
  const f = await fixture();
  assert.deepEqual(await f.service.cancel(ctx, f.input), { status: 'SUCCEEDED', operationId: f.input.operationId, paymentId: f.input.paymentId });
  const final = await snapshot(f);
  assert.equal(final.order[0].state, 'Cancelled');
  assert.equal(final.line[0].quantity, 0);
  assert.equal(final.payment[0].state, 'Cancelled');
  assert.equal(final.stock[0]!.stockAllocated, 0);
  assert.equal(final.marker?.status, 'SUCCEEDED');
  assert.equal(final.marker?.paymentId, f.input.paymentId);
  await f.service.cancel(ctx, f.input);
  assert.deepEqual(await snapshot(f), final);
  await assert.rejects(f.service.cancel(ctx, { ...f.input, paymentId: 'other' }), /CONFLICT/);
});

test('fresh facts reject settlement and fulfillment changes after preview without provider writes', async () => {
  const f = await fixture();
  await orders.settlePayment(ctx, f.payment.id);
  const settled = await snapshot(f);
  await assert.rejects(f.service.cancel(ctx, f.input), /INELIGIBLE/);
  assert.deepEqual(await snapshot(f), settled);
  const g = await fixture();
  const fulfillment = await orders.createFulfillment(ctx, { lines: [{ orderLineId: g.line.id, quantity: 1 }], handler: { code: 'manual-fulfillment', arguments: [{ name: 'method', value: 'Isolated test delivery' }, { name: 'trackingCode', value: '' }] } });
  assert.ok(!isGraphQlErrorResult(fulfillment));
  const fulfilled = await snapshot(g);
  await assert.rejects(g.service.cancel(ctx, g.input), /INELIGIBLE/);
  assert.deepEqual(await snapshot(g), fulfilled);
});

test('parallel provider attempts have one order-unique winner and an immutable marker', async () => {
  const f = await fixture();
  const competing = { ...f.input, operationId: randomUUID(), workflowId: randomUUID(), previewId: randomUUID(), idempotencyKey: randomUUID() };
  const results = await Promise.allSettled([f.service.cancel(ctx, f.input), f.service.cancel(ctx, competing)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const markers = await connection.rawConnection.query('SELECT * FROM cso_zero_total_cancellation_marker WHERE order_id = ?', [f.input.orderId]);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].status, 'SUCCEEDED');
  assert.equal((await snapshot(f)).payment[0].state, 'Cancelled');
});

test('concurrent settlement and cancellation cannot leave a success marker with a settled payment', async () => {
  const f = await fixture();
  await Promise.allSettled([orders.settlePayment(ctx, f.payment.id), f.service.cancel(ctx, f.input)]);
  const final = await snapshot(f);
  if (final.marker?.status === 'SUCCEEDED') {
    assert.equal(final.payment[0].state, 'Cancelled');
    assert.equal(final.order[0].state, 'Cancelled');
    assert.equal(final.line[0].quantity, 0);
  } else {
    assert.equal(final.marker, null);
    assert.notEqual(final.payment[0].state, 'Cancelled');
    assert.notEqual(final.order[0].state, 'Cancelled');
    assert.equal(final.line[0].quantity, 1);
  }
});

test('concurrent fulfillment and cancellation cannot commit success with an added fulfillment', async () => {
  const f = await fixture();
  const owner = new AsyncLocalStorage<string>();
  const trace: { owner: string | undefined; sql: string; depth: number; active: boolean }[] = [];
  const runner = connection.rawConnection.createQueryRunner() as ReturnType<typeof connection.rawConnection.createQueryRunner> & { transactionDepth: number };
  const originalQuery = runner.query;
  if (process.env.CSO_SQLITE_TRACE === '1') runner.query = async function (sql: string, ...args: any[]) {
    if (/^(BEGIN|SAVEPOINT|RELEASE|ROLLBACK|COMMIT)/.test(sql)) trace.push({ owner: owner.getStore(), sql, depth: runner.transactionDepth, active: runner.isTransactionActive });
    return originalQuery.call(this, sql, ...args);
  };
  const fulfillmentInput = { lines: [{ orderLineId: f.line.id, quantity: 1 }], handler: { code: 'manual-fulfillment', arguments: [{ name: 'method', value: 'Isolated delivery' }, { name: 'trackingCode', value: '' }] } };
  const outcomes = await Promise.allSettled([
    owner.run('fulfillment', () => connection.withTransaction(ctx, transactionCtx => orders.createFulfillment(transactionCtx, fulfillmentInput))),
    owner.run('cancellation', () => f.service.cancel(ctx, f.input)),
  ]);
  runner.query = originalQuery;
  if (trace.length) console.log('SQLite transaction ownership trace', JSON.stringify(trace));
  const facts = await f.service.getFacts(ctx, f.input.orderId);
  const marker = await f.service.getMarker(ctx, f.input.operationId);
  assert.ok(facts);
  if (marker?.status === 'SUCCEEDED') {
    assert.equal(facts.fulfillmentCount, 0);
    assert.equal(facts.state, 'Cancelled');
    assert.equal(facts.payment?.state, 'Cancelled');
  } else {
    assert.equal(marker, null, JSON.stringify({ outcomes: outcomes.map(result => result.status === 'rejected' ? { status: result.status, error: String(result.reason) } : { status: result.status }), orderState: facts.state, paymentState: facts.payment?.state, fulfillmentCount: facts.fulfillmentCount, markerStatus: marker?.status }));
    assert.notEqual(facts.state, 'Cancelled');
    assert.notEqual(facts.payment?.state, 'Cancelled');
  }
});

// KNOWN BLOCKER: TypeORM better-sqlite3 caches one QueryRunner per DataSource.
// An unrelated Admin transaction started while cancellation is open is treated
// as a nested savepoint. Its successful commit releases only that savepoint;
// cancellation's outer rollback then erases its acknowledged fulfillment.
// The Admin resolver's @Transaction() does not establish independent ownership.
// Reproduce with CSO_REPRODUCE_SQLITE_HAZARD=1; do not enable this journey until
// independent cross-request transaction ownership (e.g. PostgreSQL) passes this
// test along with both fault-point rollback and concurrent payment/order tests.
test('KNOWN SQLITE BLOCKER: separately successful Admin fulfillment disappears on cancellation rollback', {
  skip: process.env.CSO_REPRODUCE_SQLITE_HAZARD !== '1' && 'Provider remains unregistered: cached SQLite QueryRunner conflates separate Admin transactions; opt in to reproduce',
}, async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let fulfillmentId: string | undefined;
  f = await fixture(undefined, async () => {
    const result = await connection.withTransaction(ctx, transactionCtx => orders.createFulfillment(transactionCtx, {
      lines: [{ orderLineId: f.line.id, quantity: 1 }],
      handler: { code: 'manual-fulfillment', arguments: [{ name: 'method', value: 'Isolated delivery' }, { name: 'trackingCode', value: '' }] },
    }));
    assert.ok(!isGraphQlErrorResult(result));
    fulfillmentId = String(result.id);
  });
  await assert.rejects(f.service.cancel(ctx, f.input), /PAYMENT_STATE_INVALID/);
  const facts = await f.service.getFacts(ctx, f.input.orderId);
  assert.ok(fulfillmentId);
  assert.ok(facts);
  assert.equal(facts.fulfillmentCount, 1, 'A separately successful Admin transaction must remain committed');
  assert.equal(facts.payment?.state, 'Authorized');
  assert.equal(await f.service.getMarker(ctx, f.input.operationId), null);
});

test('existing zero-total policy marker prevents an authorized-policy write to the same order', async () => {
  const f = await fixture();
  await connection.rawConnection.query(`INSERT INTO cso_zero_total_cancellation_marker
    (operation_id,order_id,tenant_id,environment_id,customer_id,order_reference,facts_digest,workflow_id,preview_id,preview_expires_at,policy_version,idempotency_key,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ['zero-op',f.input.orderId,'isolated','test',f.input.customerId,f.input.orderReference,'0'.repeat(64),'zero-workflow','zero-preview',f.input.previewExpiresAt,'NO_PAYMENT_ZERO_TOTAL_V1','zero-key','PENDING']);
  const before = await snapshot(f);
  await assert.rejects(f.service.cancel(ctx, f.input), /CONFLICT/);
  assert.deepEqual(await snapshot(f), before);
  const [marker] = await connection.rawConnection.query('SELECT policy_version,payment_id FROM cso_zero_total_cancellation_marker WHERE order_id = ?', [f.input.orderId]);
  assert.equal(marker.policy_version, 'NO_PAYMENT_ZERO_TOTAL_V1');
  assert.equal(marker.payment_id, null);
});
