import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  bootstrapWorker, Channel, CurrencyCode, CustomerService, DefaultLogger, isGraphQlErrorResult,
  LanguageCode, LogLevel, Order, OrderService, RequestContext, RequestContextService,
  TransactionalConnection, VendureWorker,
} from '@vendure/core';
import { ZeroTotalCancellationMarker1760000000000 } from '../src/migrations/1760000000000-ZeroTotalCancellationMarker';
import { ZeroTotalCancellationScope1760000000001 } from '../src/migrations/1760000000001-ZeroTotalCancellationScope';
import { ZeroTotalCancellationService } from '../src/plugins/zero-total-cancellation/service';
import { ZeroTotalCancellationPlugin } from '../src/plugins/zero-total-cancellation/plugin';

// Reuse Vendure's installed GraphQL runtime rather than adding a test dependency.
const { buildASTSchema, concatAST, graphql, parse } = require(require.resolve('graphql', { paths: [require.resolve('@vendure/core')] }));

let worker: VendureWorker;
let connection: TransactionalConnection;
let ctx: RequestContext;
let foreignCtx: RequestContext;
let service: ZeroTotalCancellationService;

before(async () => {
  // No running simulator configuration, database, real orders or provider calls.
  worker = await bootstrapWorker({
    logger: new DefaultLogger({ level: LogLevel.Error }),
    dbConnectionOptions: { type: 'better-sqlite3', database: ':memory:', synchronize: true },
    authOptions: { superadminCredentials: { identifier: 'isolated-marker-test', password: 'isolated-test-password' } },
  });
  connection = worker.app.get(TransactionalConnection);
  const contexts = worker.app.get(RequestContextService);
  ctx = await contexts.create({ apiType: 'admin' });
  const foreign = await connection.getRepository(ctx, Channel).save(new Channel({
    code: 'foreign-marker-test', token: 'isolated-foreign-marker-test', description: '',
    defaultLanguageCode: LanguageCode.en, availableLanguageCodes: [LanguageCode.en],
    defaultCurrencyCode: CurrencyCode.USD, availableCurrencyCodes: [CurrencyCode.USD],
    trackInventory: true, outOfStockThreshold: 0, pricesIncludeTax: false,
  }));
  foreignCtx = await contexts.create({ apiType: 'admin', channelOrToken: foreign });
  const runner = { query: (sql: string) => connection.rawConnection.query(sql) };
  await new ZeroTotalCancellationMarker1760000000000().up(runner);
  await new ZeroTotalCancellationScope1760000000001().up(runner);
  service = new ZeroTotalCancellationService(connection, worker.app.get(OrderService));
});
after(async () => { await worker?.app.close(); });

async function fixture(markerStatus = 'SUCCEEDED') {
  const operationId = randomUUID();
  const customer = await worker.app.get(CustomerService).create(ctx, {
    firstName: 'Isolated', lastName: 'Marker', emailAddress: `${operationId}@example.invalid`,
  });
  assert.ok(!isGraphQlErrorResult(customer));
  const order = await connection.getRepository(ctx, Order).save(new Order({
    code: operationId, type: 'Regular' as never, state: 'Cancelled', active: false,
    customer, channels: [ctx.channel], currencyCode: CurrencyCode.USD, couponCodes: [],
    shippingAddress: {}, billingAddress: {}, subTotal: 0, subTotalWithTax: 0, shipping: 0, shippingWithTax: 0,
  }));
  await connection.getRepository(ctx, Order).query(`INSERT INTO cso_zero_total_cancellation_marker
    (operation_id,order_id,tenant_id,environment_id,customer_id,order_reference,facts_digest,
     workflow_id,preview_id,preview_expires_at,policy_version,idempotency_key,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [operationId, String(order.id), 'isolated', 'test', String(customer.id), order.code,
    '0'.repeat(64), 'workflow', 'preview', '2099-01-01T00:00:00.000Z', 'NO_PAYMENT_ZERO_TOTAL_V1', 'key', markerStatus]);
  return { operationId, order, customer };
}

test('foreign-channel operation markers are indistinguishable from missing markers', async () => {
  const f = await fixture();
  assert.equal(await service.getMarker(foreignCtx, f.operationId), null);
  assert.equal(await service.getMarker(foreignCtx, randomUUID()), null);
  assert.equal((await service.getMarker(ctx, f.operationId))?.status, 'SUCCEEDED');
});

test('orphan markers do not reveal details when the order no longer exists', async () => {
  const f = await fixture();
  await connection.getRepository(ctx, Order).delete(f.order.id);
  assert.equal(await service.getMarker(ctx, f.operationId), null);
});

test('markers must still match the persisted customer and order reference', async () => {
  for (const change of [{ customerId: () => 'NULL' }, { code: 'other-order-reference' }]) {
    const f = await fixture();
    await connection.getRepository(ctx, Order).update(f.order.id, change);
    assert.equal(await service.getMarker(ctx, f.operationId), null);
  }
});

test('optional requested customer and order scope is enforced, including numeric GraphQL IDs', async () => {
  const f = await fixture();
  const lookup = service.getMarker.bind(service) as (ctx: RequestContext, operationId: string, scope: { orderId?: string | number; customerId?: string | number }) => ReturnType<typeof service.getMarker>;
  assert.equal(await lookup(ctx, f.operationId, { customerId: 'different' }), null);
  assert.equal(await lookup(ctx, f.operationId, { orderId: 'different' }), null);
  assert.equal((await lookup(ctx, f.operationId, { orderId: f.order.id, customerId: f.customer.id }))?.operationId, f.operationId);
  assert.equal((await lookup(ctx, f.operationId, { customerId: String(f.customer.id) }))?.operationId, f.operationId);
});

test('marker lookup uses the supplied transaction context and observes rollback without mutation', async () => {
  const f = await fixture('PENDING');
  await assert.rejects(connection.withTransaction(ctx, async transactionCtx => {
    await connection.getRepository(transactionCtx, Order).query(
      "UPDATE cso_zero_total_cancellation_marker SET status = 'SUCCEEDED' WHERE operation_id = ?", [f.operationId]);
    assert.equal((await service.getMarker(transactionCtx, f.operationId))?.status, 'SUCCEEDED');
    await connection.getRepository(transactionCtx, Order).update(f.order.id, { customerId: () => 'NULL' });
    assert.equal(await service.getMarker(transactionCtx, f.operationId), null);
    throw new Error('ISOLATED_ROLLBACK');
  }), /ISOLATED_ROLLBACK/);
  assert.equal((await service.getMarker(ctx, f.operationId))?.status, 'PENDING');
});

test('same-channel marker lookup replays unchanged and shared-channel membership is supported', async () => {
  const f = await fixture();
  const first = await service.getMarker(ctx, f.operationId);
  assert.ok(first);
  assert.deepEqual(await service.getMarker(ctx, f.operationId), first);
  await connection.getRepository(ctx, Order).save(new Order({ id: f.order.id, channels: [ctx.channel, foreignCtx.channel] }));
  assert.deepEqual(await service.getMarker(foreignCtx, f.operationId), first);
});

test('foreign-channel or wrong-owner cancellation replay does not disclose marker conflict fields', async () => {
  const f = await fixture();
  const input = {
    operationId: f.operationId, tenantId: 'isolated', environmentId: 'test', customerId: String(f.customer.id),
    orderId: String(f.order.id), orderReference: f.order.code, expectedFactsDigest: '0'.repeat(64),
    workflowId: 'different-workflow', previewId: 'preview', previewExpiresAt: '2099-01-01T00:00:00.000Z',
    policyVersion: 'NO_PAYMENT_ZERO_TOTAL_V1', idempotencyKey: 'key',
  };
  const initial = await service.getMarker(ctx, f.operationId);
  await assert.rejects(service.cancel(foreignCtx, input), /^Error: ZERO_TOTAL_CANCELLATION_NOT_FOUND$/);
  await assert.rejects(service.cancel(ctx, { ...input, customerId: 'different' }), /^Error: ZERO_TOTAL_CANCELLATION_NOT_FOUND$/);
  assert.deepEqual(await service.getMarker(ctx, f.operationId), initial);
});

test('registered GraphQL marker query preserves legacy calls and forwards optional owner/order scope', async () => {
  const f = await fixture();
  const extensions = Reflect.getMetadata('adminApiExtensions', ZeroTotalCancellationPlugin) as {
    schema: unknown;
    resolvers: (new (service: ZeroTotalCancellationService) => {
      zeroTotalCancellationMarker(ctx: RequestContext, operationId: string, orderId?: string, customerId?: string): ReturnType<typeof service.getMarker>;
    })[];
  };
  const schema = buildASTSchema(concatAST([parse(`
    scalar DateTime
    scalar Money
    enum OrderType { Regular }
    enum CurrencyCode { USD }
    type Query { unused: Boolean }
    type Mutation { unused: Boolean }
  `), extensions.schema]));
  const resolver = new extensions.resolvers[0]!(service);
  const rootValue = {
    zeroTotalCancellationMarker: (args: { operationId: string; orderId?: string; customerId?: string }) =>
      resolver.zeroTotalCancellationMarker(ctx, args.operationId, args.orderId, args.customerId),
  };
  const legacy = await graphql({ schema, rootValue, source: 'query($operationId:String!){zeroTotalCancellationMarker(operationId:$operationId){operationId}}', variableValues: { operationId: f.operationId } });
  assert.equal(legacy.errors, undefined);
  assert.equal(legacy.data?.zeroTotalCancellationMarker.operationId, f.operationId);
  const scoped = await graphql({ schema, rootValue, source: 'query($operationId:String!,$orderId:ID,$customerId:ID){zeroTotalCancellationMarker(operationId:$operationId,orderId:$orderId,customerId:$customerId){operationId}}', variableValues: { operationId: f.operationId, orderId: f.order.id, customerId: 'different' } });
  assert.equal(scoped.errors, undefined);
  assert.equal(scoped.data?.zeroTotalCancellationMarker, null);
});
