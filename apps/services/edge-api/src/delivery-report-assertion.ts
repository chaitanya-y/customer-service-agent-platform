import { createHash } from 'node:crypto';

import { SignJWT } from 'jose';
import { z } from 'zod';

import type { AuthenticatedCustomer } from './customer-identity.js';

export const DELIVERY_REPORT_ASSERTION_HEADER = 'x-cso-delivery-report-assertion';

const opaqueId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const identitySchema = z.object({
  principalId: opaqueId,
  customerId: opaqueId,
  tenantId: opaqueId,
  environmentId: opaqueId,
}).strict().superRefine((identity, context) => {
  if (identity.principalId !== identity.customerId) {
    context.addIssue({ code: 'custom', path: ['principalId'], message: 'Self-service identity is required' });
  }
});
const inputSchema = z.discriminatedUnion('purpose', [
  z.object({
    purpose: z.literal('delivery_issue_report_create'),
    identity: identitySchema,
    conversationId: opaqueId,
    orderReference: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    category: z.enum(['MISSING', 'WRONG', 'DAMAGED', 'DELAYED']),
    idempotencyKey: opaqueId,
    requestId: opaqueId,
  }).strict(),
  z.object({
    purpose: z.literal('delivery_issue_report_replay'),
    identity: identitySchema,
    conversationId: opaqueId,
    orderReference: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    category: z.enum(['MISSING', 'WRONG', 'DAMAGED', 'DELAYED']),
    idempotencyKey: opaqueId,
    requestId: opaqueId,
  }).strict(),
  z.object({
    purpose: z.literal('delivery_issue_report_read'),
    identity: identitySchema,
    reportId: opaqueId,
    requestId: opaqueId,
  }).strict(),
  z.object({
    purpose: z.literal('delivery_issue_report_list'),
    identity: identitySchema,
    requestId: opaqueId,
  }).strict(),
]);

export type DeliveryReportAssertionInput =
  | {
      purpose: 'delivery_issue_report_create' | 'delivery_issue_report_replay';
      identity: AuthenticatedCustomer;
      conversationId: string;
      orderReference: string;
      category: 'MISSING' | 'WRONG' | 'DAMAGED' | 'DELAYED';
      idempotencyKey: string;
      requestId: string;
    }
  | {
      purpose: 'delivery_issue_report_read';
      identity: AuthenticatedCustomer;
      reportId: string;
      requestId: string;
    }
  | {
      purpose: 'delivery_issue_report_list';
      identity: AuthenticatedCustomer;
      requestId: string;
    };

export type SignDeliveryReportAssertion = (input: DeliveryReportAssertionInput) => Promise<string>;

export function createDeliveryReportAssertionSigner({
  secret,
  issuer,
  audience,
  lifetimeSeconds = 60,
  now = () => new Date(),
}: {
  secret: string;
  issuer: string;
  audience: string;
  lifetimeSeconds?: number;
  now?: () => Date;
}): SignDeliveryReportAssertion {
  if (Buffer.byteLength(secret, 'utf8') < 32 ||
      !Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 300) {
    throw new Error('Invalid delivery report assertion settings');
  }
  const key = new TextEncoder().encode(secret);
  return async (unvalidated) => {
    const input = inputSchema.parse(unvalidated);
    const issuedAt = Math.floor(now().getTime() / 1_000);
    const common = {
      tenantId: input.identity.tenantId,
      environmentId: input.identity.environmentId,
      subjectCustomerId: input.identity.customerId,
      requestId: input.requestId,
      purpose: input.purpose,
    };
    const purposeClaims = input.purpose === 'delivery_issue_report_create' || input.purpose === 'delivery_issue_report_replay'
      ? {
          conversationId: input.conversationId,
          orderReference: input.orderReference,
          category: input.category,
          idempotencyKey: input.idempotencyKey,
          bodySha256: createHash('sha256').update(JSON.stringify({
            order_reference: input.orderReference,
            category: input.category,
          })).digest('hex'),
        }
      : input.purpose === 'delivery_issue_report_read' ? { reportId: input.reportId } : {};
    return new SignJWT({ ...common, ...purposeClaims })
      .setProtectedHeader({ alg: 'HS256', typ: 'cso-delivery-report+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + lifetimeSeconds)
      .sign(key);
  };
}
