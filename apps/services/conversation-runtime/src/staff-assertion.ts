import { createHash } from 'node:crypto';
import { jwtVerify } from 'jose';
import { z } from 'zod';

export const STAFF_ASSERTION_HEADER = 'x-cso-conversation-staff-assertion';
const opaque = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const common = z.object({
  tenantId: opaque, environmentId: opaque, staffId: opaque, role: z.literal('SUPPORT_AGENT'),
  requestId: opaque, traceId: opaque, routingEpoch: z.number().int().positive(),
  iss: z.literal('customer-service-os-human-operations'), aud: z.literal('conversation-runtime-handoff'),
  iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
  path: z.string().min(1).max(500),
});
const mutation = common.extend({
  purpose: z.enum(['handoff_claim', 'handoff_reply', 'handoff_return_to_ai', 'handoff_close']),
  httpMethod: z.literal('POST'), conversationId: z.uuid(), handoffSessionId: z.uuid(),
  expectedControlVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  idempotencyKey: opaque, requestBodySha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const claimsSchema = z.union([
  common.extend({ purpose: z.literal('handoff_list'), httpMethod: z.literal('GET') }).strict(),
  common.extend({ purpose: z.literal('handoff_read'), httpMethod: z.literal('GET'), conversationId: z.uuid() }).strict(),
  mutation,
]);
export type StaffAccessContext = z.infer<typeof claimsSchema>;
export type VerifyStaffAssertion = (assertion: string | undefined) => Promise<StaffAccessContext>;
export class StaffAssertionError extends Error { constructor() { super('Staff assertion is invalid'); } }

export function canonicalHandoffBodyHash(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (typeof input === 'object' && input !== null) return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return input;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function createHmacStaffAssertionVerifier(options: { secret: string; expectedTenantId: string; expectedEnvironmentId: string; now?: () => Date }): VerifyStaffAssertion {
  if (Buffer.byteLength(options.secret, 'utf8') < 32) throw new Error('Staff assertion secret must contain at least 32 bytes');
  return async (assertion) => {
    try {
      if (!assertion || assertion.length > 8192) throw new StaffAssertionError();
      const now = (options.now ?? (() => new Date()))();
      const { payload } = await jwtVerify(assertion, new TextEncoder().encode(options.secret), { algorithms: ['HS256'], issuer: 'customer-service-os-human-operations', audience: 'conversation-runtime-handoff', typ: 'cso-conversation-staff+jwt', currentDate: now });
      const claims = claimsSchema.parse(payload);
      const seconds = Math.floor(now.getTime() / 1000);
      if (claims.tenantId !== options.expectedTenantId || claims.environmentId !== options.expectedEnvironmentId || claims.iat > seconds + 30 || claims.exp <= seconds || claims.exp <= claims.iat || claims.exp - claims.iat > 300) throw new StaffAssertionError();
      const suffix = { handoff_claim: 'claim', handoff_reply: 'messages', handoff_return_to_ai: 'return-to-ai', handoff_close: 'close' };
      const path = claims.purpose === 'handoff_list' ? '/v1/internal/handoffs' : claims.purpose === 'handoff_read' ? `/v1/internal/handoffs/${claims.conversationId}` : `/v1/internal/handoffs/${claims.conversationId}/${suffix[claims.purpose]}`;
      if (claims.path !== path) throw new StaffAssertionError();
      return claims;
    } catch { throw new StaffAssertionError(); }
  };
}
