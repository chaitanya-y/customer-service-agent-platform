import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { RequestHumanHandoff } from './conversation-runtime-client.js';
import type { SignContextAssertion } from './context-assertion.js';
import type { AuthenticatedCustomer } from './customer-identity.js';

const conversationIdSchema = z.uuid();
const requestSchema = z.object({ expected_control_version: z.number().int().positive() }).strict();
const idempotencyKeySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const controlStateSchema = z.object({
  conversationId: conversationIdSchema,
  status: z.literal('OPEN'),
  controlMode: z.enum(['QUEUED', 'HUMAN']),
  controlVersion: z.number().int().positive(),
  handoffSessionId: conversationIdSchema,
}).passthrough();
const responseSchema = z.object({ data: controlStateSchema }).passthrough();

export function registerHumanHandoffRoutes(app: FastifyInstance, options: {
  verifyRequestIdentity: (authorization: string | undefined) => Promise<AuthenticatedCustomer>;
  createCorrelationId: () => string;
  signConversationContext?: SignContextAssertion;
  requestHumanHandoff?: RequestHumanHandoff;
}): void {
  app.post('/v1/conversations/:conversationId/handoff', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const params = z.object({ conversationId: conversationIdSchema }).strict().safeParse(request.params);
    const body = requestSchema.safeParse(request.body);
    const key = idempotencyKeySchema.safeParse(request.headers['idempotency-key']);
    if (!params.success || !body.success || !key.success) {
      return reply.code(400).send({ error: { code: 'invalid_handoff_request', message: 'Handoff request is invalid' } });
    }
    let identity: AuthenticatedCustomer;
    try {
      identity = await options.verifyRequestIdentity(request.headers.authorization);
    } catch {
      return reply.code(401).send({ error: { code: 'customer_unauthorized', message: 'Customer authentication is required' } });
    }
    if (!options.signConversationContext || !options.requestHumanHandoff) {
      return reply.code(503).send({ error: { code: 'handoff_unavailable', message: 'Human support is unavailable' } });
    }
    const conversationId = params.data.conversationId;
    const scopedKey = `cso-${createHash('sha256').update(JSON.stringify([
      'human-chat-handoff-v1', identity.tenantId, identity.environmentId,
      identity.customerId, conversationId, key.data,
    ])).digest('hex')}`;
    try {
      const assertion = await options.signConversationContext({
        identity, requestId: options.createCorrelationId(),
        traceId: options.createCorrelationId(), channelId: 'web',
      });
      const response = await options.requestHumanHandoff({
        conversationId, contextAssertion: assertion,
        idempotencyKey: scopedKey,
        expectedControlVersion: body.data.expected_control_version,
      });
      if (response.statusCode === 404) {
        return reply.code(404).send({ error: { code: 'conversation_not_found', message: 'Conversation was not found' } });
      }
      if (response.statusCode === 409) {
        return reply.code(409).send({ error: { code: 'handoff_state_changed', message: 'Conversation changed. Refresh and try again.' } });
      }
      if (response.statusCode !== 200) throw new Error('Handoff unavailable');
      const parsed = responseSchema.safeParse(response.body);
      if (!parsed.success || parsed.data.data.conversationId !== conversationId ||
          parsed.data.data.controlVersion <= body.data.expected_control_version) {
        throw new Error('Invalid handoff response');
      }
      const state = parsed.data.data;
      return reply.send({
        conversation_id: state.conversationId,
        status: state.status,
        control_mode: state.controlMode,
        control_version: state.controlVersion,
        handoff_session_id: state.handoffSessionId,
      });
    } catch {
      return reply.code(503).send({ error: { code: 'handoff_unavailable', message: 'Human support is unavailable' } });
    }
  });
}
