import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { RequestInstrumentation } from '@cso/observability-node';

import type { CommerceProvider } from './commerce.js';
import { registerDeliveryOrderOwnershipRoutes } from './delivery-order-ownership-routes.js';
import { createGetOrderContext } from './get-order-context.js';
import { createGetRefundContext } from './get-refund-context.js';
import type { GetProductCatalog } from './product-catalog.js';
import type { GetSavedAddressStatus } from './saved-address-status.js';
import { registerSavedAddressStatusRoutes } from './saved-address-status-routes.js';
import type { GetRecentOrderReferences } from './recent-order-references.js';
import { registerRecentOrderReferencesRoutes } from './recent-order-references-routes.js';
import { createGetPaymentStatus } from './payment-status.js';
import { registerMcpRoutes } from './mcp-routes.js';
import { registerOrderRoutes } from './order-routes.js';
import { registerRefundContextRoutes } from './refund-context-routes.js';
import { registerRefundExecutionRoutes } from './refund-execution-routes.js';
import { registerRefundReconciliationRoutes } from './refund-reconciliation-routes.js';
import { registerProviderRefundEventRoutes, type VerifyProviderRefundEventSignature } from './provider-refund-event-routes.js';
import { InMemoryRefundExecutionRepository, type RefundExecutionRepository } from './refund-execution-repository.js';
import type { VerifyContextAssertion } from './trusted-context.js';
import type { VerifyWorkflowAccessAssertion } from './workflow-access.js';
import { instrumentHttpServer } from './observability.js';
import { registerZeroTotalCancellationRoutes } from './zero-total-cancellation-routes.js';
import { registerAuthorizedDummyCancellationRoutes } from './authorized-dummy-cancellation-routes.js';
import type { AuthorizedDummyCancellationProvider } from './vendure-authorized-dummy-cancellation-client.js';
import type { ZeroTotalCancellationProvider } from './vendure-zero-total-cancellation-client.js';
import type { ZeroTotalCancellationRepository } from './zero-total-cancellation-repository.js';

type BuildAppOptions = {
  commerceProvider: CommerceProvider;
  getProductCatalog?: GetProductCatalog;
  getSavedAddressStatus?: GetSavedAddressStatus;
  getRecentOrderReferences?: GetRecentOrderReferences;
  verifyContextAssertion: VerifyContextAssertion;
  verifyWorkflowAccessAssertion?: VerifyWorkflowAccessAssertion;
  verifyWorkflowRefundExecutionAssertion?: VerifyWorkflowAccessAssertion;
  verifyWorkflowRefundReconciliationAssertion?: VerifyWorkflowAccessAssertion;
  refundExecutionRepository?: RefundExecutionRepository;
  verifyProviderRefundEventSignature?: VerifyProviderRefundEventSignature;
  logger?: boolean;
  loggerStream?: { write(message: string): void };
  telemetry?: RequestInstrumentation;
  zeroTotalCancellationProvider?: ZeroTotalCancellationProvider;
  zeroTotalCancellationRepository?: ZeroTotalCancellationRepository;
  zeroTotalCancellationScope?: { tenantId: string; environmentId: string };
  verifyWorkflowCancellationFactsAssertion?: VerifyWorkflowAccessAssertion;
  verifyWorkflowCancellationExecutionAssertion?: VerifyWorkflowAccessAssertion;
  verifyWorkflowCancellationReconciliationAssertion?: VerifyWorkflowAccessAssertion;
  authorizedDummyCancellationProvider?: AuthorizedDummyCancellationProvider;
  authorizedDummyCancellationRepository?: ZeroTotalCancellationRepository;
  authorizedDummyCancellationScope?: { tenantId: string; environmentId: string };
  verifyWorkflowAuthorizedDummyFactsAssertion?: VerifyWorkflowAccessAssertion;
  verifyWorkflowAuthorizedDummyExecutionAssertion?: VerifyWorkflowAccessAssertion;
  verifyWorkflowAuthorizedDummyReconciliationAssertion?: VerifyWorkflowAccessAssertion;
};

export function buildApp(
  options: BuildAppOptions,
): FastifyInstance {
  const app = Fastify({
    logger: options.logger
      ? {
          serializers: {
            req: () => ({}),
            res: () => ({}),
            err: () => ({
              type: 'application_error',
              message: 'application error',
              stack: '',
            }),
          },
          ...(options.loggerStream ? { stream: options.loggerStream } : {}),
        }
      : false,
    // Fastify's default request and 404 logs include the raw URL, including query values.
    logController: new LogController({ disableRequestLogging: true }),
  });
  instrumentHttpServer(app, options.telemetry);

  app.get('/health', async () => ({
    service: 'integration-gateway',
    status: 'ok',
  }));

  const getOrderContext = createGetOrderContext({
    commerceProvider: options.commerceProvider,
  });
  const getRefundContext = createGetRefundContext({
    commerceProvider: options.commerceProvider,
  });

  registerOrderRoutes(
    app,
    getOrderContext,
    options.verifyContextAssertion,
  );
  registerSavedAddressStatusRoutes(app, options.verifyContextAssertion, options.getSavedAddressStatus);
  registerRecentOrderReferencesRoutes(app, options.verifyContextAssertion, options.getRecentOrderReferences);
  registerDeliveryOrderOwnershipRoutes(
    app,
    getOrderContext,
    options.verifyContextAssertion,
  );
  registerRefundContextRoutes(
    app,
    getRefundContext,
    options.verifyContextAssertion,
    options.verifyWorkflowAccessAssertion,
  );
  const refundExecutionRepository = options.refundExecutionRepository ?? new InMemoryRefundExecutionRepository();
  registerRefundExecutionRoutes(app, options.commerceProvider, refundExecutionRepository, options.verifyWorkflowRefundExecutionAssertion);
  registerRefundReconciliationRoutes(app, options.commerceProvider, refundExecutionRepository, options.verifyWorkflowRefundReconciliationAssertion);
  registerProviderRefundEventRoutes(app, refundExecutionRepository, options.verifyProviderRefundEventSignature);
  if (options.zeroTotalCancellationProvider && options.zeroTotalCancellationRepository && options.zeroTotalCancellationScope) {
    registerZeroTotalCancellationRoutes(app, {
      commerceProvider: options.commerceProvider,
      cancellationProvider: options.zeroTotalCancellationProvider,
      repository: options.zeroTotalCancellationRepository,
      expectedTenantId: options.zeroTotalCancellationScope.tenantId,
      expectedEnvironmentId: options.zeroTotalCancellationScope.environmentId,
      verifyCustomerContext: options.verifyContextAssertion,
      verifyWorkflowFacts: options.verifyWorkflowCancellationFactsAssertion,
      verifyWorkflowExecute: options.verifyWorkflowCancellationExecutionAssertion,
      verifyWorkflowReconcile: options.verifyWorkflowCancellationReconciliationAssertion,
    });
  }
  // Deliberately not enabled by the running server until provider race proof passes.
  if (options.authorizedDummyCancellationProvider && options.authorizedDummyCancellationRepository
    && options.authorizedDummyCancellationScope) {
    registerAuthorizedDummyCancellationRoutes(app, {
      commerceProvider: options.commerceProvider,
      cancellationProvider: options.authorizedDummyCancellationProvider,
      repository: options.authorizedDummyCancellationRepository,
      expectedTenantId: options.authorizedDummyCancellationScope.tenantId,
      expectedEnvironmentId: options.authorizedDummyCancellationScope.environmentId,
      verifyCustomerContext: options.verifyContextAssertion,
      ...(options.verifyWorkflowAuthorizedDummyFactsAssertion && { verifyWorkflowFacts: options.verifyWorkflowAuthorizedDummyFactsAssertion }),
      ...(options.verifyWorkflowAuthorizedDummyExecutionAssertion && { verifyWorkflowExecute: options.verifyWorkflowAuthorizedDummyExecutionAssertion }),
      ...(options.verifyWorkflowAuthorizedDummyReconciliationAssertion && { verifyWorkflowReconcile: options.verifyWorkflowAuthorizedDummyReconciliationAssertion }),
    });
  }
  registerMcpRoutes(
    app,
    getOrderContext,
    options.verifyContextAssertion,
    createGetPaymentStatus(options.commerceProvider),
    options.getProductCatalog,
    options.getRecentOrderReferences,
  );

  return app;
}
