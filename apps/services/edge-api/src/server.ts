import { createAgentRuntimeClient } from './agent-runtime-client.js';
import { Connection, WorkflowClient } from '@temporalio/client';
import { getRefundPolicyBinding } from '../../../../packages/refund-policy/index.mjs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createConversationRuntimeClient } from './conversation-runtime-client.js';
import {
  createHmacContextAssertionSigner,
  createHmacServiceAssertionSigner,
} from './context-assertion.js';
import { createLocalCustomerIdentityVerifier } from './local-customer-auth.js';
import { createTemporalRefundClient } from './temporal-refund-client.js';
import { createTemporalCancellationClient } from './temporal-cancellation-client.js';
import { createEvidenceAssertionSigner, createRefundEvidenceClient } from './refund-evidence-client.js';
import { createDeliveryReportAssertionSigner } from './delivery-report-assertion.js';
import { createDeliveryReportClient } from './delivery-report-client.js';
import { createSavedAddressStatusClient } from './saved-address-status-client.js';
import { createRecentOrderReferencesClient } from './recent-order-references-client.js';
import type { TelemetryHandle } from '@cso/observability-node';
import { closeFastifyWithin, runWithin } from './observability.js';

export async function startServer({ telemetry }: { telemetry: TelemetryHandle }) {
  const config = loadConfig();
  const verifyCustomerIdentity = createLocalCustomerIdentityVerifier({
    secret: config.LOCAL_AUTH_HMAC_SECRET,
    expectedIssuer: config.LOCAL_AUTH_ISSUER,
    expectedAudience: config.LOCAL_AUTH_AUDIENCE,
    expectedTenantId: config.TENANT_ID,
    expectedEnvironmentId: config.ENVIRONMENT_ID,
  });
  const signContextAssertion = createHmacContextAssertionSigner({
    secret: config.CONTEXT_ASSERTION_HMAC_SECRET,
    issuer: config.CONTEXT_ASSERTION_ISSUER,
    audience: config.CONTEXT_ASSERTION_AUDIENCE,
    route: {
      homeRegion: config.HOME_REGION,
      homeCell: config.HOME_CELL,
      routingEpoch: config.ROUTING_EPOCH,
    },
  });
  const signAgentRuntimeContextAssertion = createHmacContextAssertionSigner({
    secret: config.CONTEXT_ASSERTION_HMAC_SECRET,
    issuer: config.CONTEXT_ASSERTION_ISSUER,
    audience: config.AGENT_RUNTIME_CONTEXT_ASSERTION_AUDIENCE,
    route: {
      homeRegion: config.HOME_REGION,
      homeCell: config.HOME_CELL,
      routingEpoch: config.ROUTING_EPOCH,
    },
    refundPolicy: getRefundPolicyBinding(config.REFUND_POLICY_VERSION),
  });
  const signKnowledgeRagContextAssertion = createHmacContextAssertionSigner({
    secret: config.CONTEXT_ASSERTION_HMAC_SECRET,
    issuer: config.CONTEXT_ASSERTION_ISSUER,
    audience: config.KNOWLEDGE_RAG_CONTEXT_ASSERTION_AUDIENCE,
    route: {
      homeRegion: config.HOME_REGION,
      homeCell: config.HOME_CELL,
      routingEpoch: config.ROUTING_EPOCH,
    },
  });
  const signConversationRuntimeContextAssertion = createHmacContextAssertionSigner({
    secret: config.CONTEXT_ASSERTION_HMAC_SECRET,
    issuer: config.CONTEXT_ASSERTION_ISSUER,
    audience: config.CONVERSATION_RUNTIME_CONTEXT_ASSERTION_AUDIENCE,
    route: {
      homeRegion: config.HOME_REGION,
      homeCell: config.HOME_CELL,
      routingEpoch: config.ROUTING_EPOCH,
    },
  });
  const signEdgeServiceAssertion = createHmacServiceAssertionSigner({
    secret: config.EDGE_SERVICE_ASSERTION_HMAC_SECRET,
    issuer: config.EDGE_SERVICE_ASSERTION_ISSUER,
    audience: config.EDGE_SERVICE_ASSERTION_AUDIENCE,
    routingEpoch: config.ROUTING_EPOCH,
  });
  const agentRuntimeClient = createAgentRuntimeClient({
    baseUrl: config.AGENT_RUNTIME_BASE_URL,
    timeoutMilliseconds: config.AGENT_RUNTIME_TIMEOUT_MILLISECONDS,
    telemetry,
  });
  const conversationRuntimeClient = createConversationRuntimeClient({
    baseUrl: config.CONVERSATION_RUNTIME_BASE_URL,
    timeoutMilliseconds: config.CONVERSATION_RUNTIME_TIMEOUT_MILLISECONDS,
  });
  const temporalConnection = await Connection.connect({
    address: config.TEMPORAL_ADDRESS,
  });
  const workflowClient = new WorkflowClient({ connection: temporalConnection });
  const temporalRefundClient = createTemporalRefundClient({
    client: workflowClient,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
  });
  const temporalCancellationClient = createTemporalCancellationClient({
    client: workflowClient,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
  });
  const refundEvidenceClient = createRefundEvidenceClient({
    baseUrl: config.HUMAN_OPERATIONS_BASE_URL,
    timeoutMilliseconds: config.EVIDENCE_REQUEST_TIMEOUT_MILLISECONDS,
    signAssertion: createEvidenceAssertionSigner({
      secret: config.CONTEXT_ASSERTION_HMAC_SECRET,
      issuer: config.CONTEXT_ASSERTION_ISSUER,
    }),
  });
  const deliveryReportClient = createDeliveryReportClient({
    gatewayBaseUrl: config.INTEGRATION_GATEWAY_BASE_URL,
    humanOperationsBaseUrl: config.HUMAN_OPERATIONS_BASE_URL,
    timeoutMilliseconds: config.DELIVERY_REPORT_REQUEST_TIMEOUT_MILLISECONDS,
  });
  const savedAddressStatusClient = createSavedAddressStatusClient({
    baseUrl: config.INTEGRATION_GATEWAY_BASE_URL,
    timeoutMilliseconds: config.DELIVERY_REPORT_REQUEST_TIMEOUT_MILLISECONDS,
  });
  const app = buildApp({
    verifyCustomerIdentity,
    signContextAssertion,
    signAgentRuntimeContextAssertion,
    signKnowledgeRagContextAssertion,
    signConversationRuntimeContextAssertion,
    signEdgeServiceAssertion,
    signDeliveryReportAssertion: createDeliveryReportAssertionSigner({
      secret: config.CONTEXT_ASSERTION_HMAC_SECRET,
      issuer: config.CONTEXT_ASSERTION_ISSUER,
      audience: config.DELIVERY_REPORT_ASSERTION_AUDIENCE,
    }),
    intakeRefund: agentRuntimeClient.intakeRefund,
    intakeSupport: agentRuntimeClient.intakeSupport,
    createConversation: conversationRuntimeClient.createConversation,
    getConversation: conversationRuntimeClient.getConversation,
    getRefundStart: conversationRuntimeClient.getRefundStart,
    ...(config.HUMAN_CHAT_HANDOFF_ENABLED
      ? { requestHumanHandoff: conversationRuntimeClient.requestHumanHandoff }
      : {}),
    acceptCustomerMessage: conversationRuntimeClient.acceptCustomerMessage,
    appendAssistantMessage: conversationRuntimeClient.appendAssistantMessage,
    linkRefundWorkflow: conversationRuntimeClient.linkRefundWorkflow,
    startRefundWorkflow: temporalRefundClient.startRefundWorkflow,
    getRefundWorkflow: temporalRefundClient.getRefundWorkflow,
    confirmRefundWorkflow: temporalRefundClient.confirmRefundWorkflow,
    startCancellationWorkflow: temporalCancellationClient.startCancellationWorkflow,
    getCancellationWorkflow: temporalCancellationClient.getCancellationWorkflow,
    confirmCancellationWorkflow: temporalCancellationClient.confirmCancellationWorkflow,
    refundEvidenceClient,
    deliveryReportClient,
    savedAddressStatusClient,
    recentOrderReferencesClient: createRecentOrderReferencesClient({
      baseUrl: config.INTEGRATION_GATEWAY_BASE_URL,
      timeoutMilliseconds: config.DELIVERY_REPORT_REQUEST_TIMEOUT_MILLISECONDS,
    }),
    refundPolicyVersion: config.REFUND_POLICY_VERSION,
    logger: true,
    telemetry,
  });

  try {
    await app.listen({
      host: config.HOST,
      port: config.PORT,
    });
  } catch (error) {
    await Promise.allSettled([
      closeFastifyWithin(app),
      runWithin(() => temporalConnection.close(), 1_000),
    ]);
    throw error;
  }
  return {
    app,
    async close() {
      await closeFastifyWithin(app);
      await runWithin(() => temporalConnection.close(), 1_000);
    },
  };
}
