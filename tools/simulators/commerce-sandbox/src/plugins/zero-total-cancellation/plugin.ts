import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, OrderService, Permission, PluginCommonModule, RequestContext, Transaction, TransactionalConnection, VendurePlugin } from '@vendure/core';
import gql from 'graphql-tag';

import { ZeroTotalCancellationService, type GuardedCancellationInput } from './service';

const schema = gql`
    type ZeroTotalCancellationLineFacts {
        id: ID!
        quantity: Int!
        orderPlacedQuantity: Int!
    }
    type ZeroTotalCancellationFacts {
        orderId: ID!
        orderReference: String!
        customerId: ID
        channelIds: [ID!]!
        orderType: OrderType!
        state: String!
        active: Boolean!
        placedAt: DateTime
        currencyCode: CurrencyCode!
        totalWithTax: Money!
        lines: [ZeroTotalCancellationLineFacts!]!
        paymentCount: Int!
        refundCount: Int!
        fulfillmentCount: Int!
        digest: String!
        eligible: Boolean!
    }
    input GuardedZeroTotalCancellationInput {
        operationId: String!
        tenantId: String!
        environmentId: String!
        customerId: ID!
        orderId: ID!
        orderReference: String!
        expectedFactsDigest: String!
        workflowId: String!
        previewId: String!
        previewExpiresAt: String!
        policyVersion: String!
        idempotencyKey: String!
    }
    type GuardedZeroTotalCancellationResult {
        status: String!
        operationId: String!
    }
    type ZeroTotalCancellationMarker {
        operationId: String!
        orderId: ID!
        tenantId: String!
        environmentId: String!
        customerId: ID!
        orderReference: String!
        factsDigest: String!
        workflowId: String!
        previewId: String!
        previewExpiresAt: String!
        policyVersion: String!
        idempotencyKey: String!
        status: String!
    }
    extend type Query {
        zeroTotalCancellationFacts(orderId: ID!): ZeroTotalCancellationFacts
        zeroTotalCancellationMarker(operationId: String!, orderId: ID, customerId: ID): ZeroTotalCancellationMarker
    }
    extend type Mutation {
        guardedCancelZeroTotalOrder(input: GuardedZeroTotalCancellationInput!): GuardedZeroTotalCancellationResult!
    }
`;

@Resolver()
class ZeroTotalCancellationResolver {
    constructor(private readonly service: ZeroTotalCancellationService) {}

    @Query()
    @Allow(Permission.ReadOrder)
    zeroTotalCancellationFacts(@Ctx() ctx: RequestContext, @Args('orderId') orderId: string) {
        return this.service.getFacts(ctx, orderId);
    }

    @Query()
    @Allow(Permission.ReadOrder)
    zeroTotalCancellationMarker(@Ctx() ctx: RequestContext, @Args('operationId') operationId: string,
        @Args('orderId') orderId?: string, @Args('customerId') customerId?: string) {
        return this.service.getMarker(ctx, operationId, { orderId, customerId });
    }

    @Mutation()
    @Allow(Permission.UpdateOrder)
    @Transaction()
    guardedCancelZeroTotalOrder(@Ctx() ctx: RequestContext, @Args('input') input: GuardedCancellationInput) {
        return this.service.cancel(ctx, input);
    }
}

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [{
        provide: ZeroTotalCancellationService,
        useFactory: (connection: TransactionalConnection, orderService: OrderService) => new ZeroTotalCancellationService(connection, orderService),
        inject: [TransactionalConnection, OrderService],
    }],
    adminApiExtensions: { schema, resolvers: [ZeroTotalCancellationResolver] },
    compatibility: '^3.7.0',
})
export class ZeroTotalCancellationPlugin {}
