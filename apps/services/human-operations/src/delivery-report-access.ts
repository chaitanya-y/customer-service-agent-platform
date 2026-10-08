import { createHash, timingSafeEqual } from 'node:crypto';
import { jwtVerify } from 'jose';
import { z } from 'zod';

export const DELIVERY_REPORT_ASSERTION_HEADER = 'x-cso-delivery-report-assertion';

const opaqueId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const orderReference = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const category = z.enum(['MISSING', 'WRONG', 'DAMAGED', 'DELAYED']);
const commonClaims = {
  tenantId: opaqueId, environmentId: opaqueId, subjectCustomerId: opaqueId,
  requestId: opaqueId, iss: z.string(), aud: z.string(),
  iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
};
const writeClaims = { ...commonClaims, conversationId: opaqueId,
  orderReference, category, idempotencyKey: opaqueId, bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
};
const createClaimsSchema = z.object({ ...writeClaims, purpose: z.literal('delivery_issue_report_create') }).strict();
const replayClaimsSchema = z.object({ ...writeClaims, purpose: z.literal('delivery_issue_report_replay') }).strict();
const readClaimsSchema = z.object({ ...commonClaims,
  purpose: z.literal('delivery_issue_report_read'), reportId: opaqueId,
}).strict();
const listClaimsSchema = z.object({ ...commonClaims, purpose: z.literal('delivery_issue_report_list') }).strict();

export type DeliveryCreateAccess = Readonly<Pick<z.infer<typeof createClaimsSchema>,
  'tenantId' | 'environmentId' | 'subjectCustomerId' | 'conversationId' | 'orderReference' | 'category' | 'idempotencyKey' | 'requestId'>>;
export type DeliveryReadAccess = Readonly<Pick<z.infer<typeof readClaimsSchema>,
  'tenantId' | 'environmentId' | 'subjectCustomerId' | 'reportId' | 'requestId'>>;
export type DeliveryListAccess = Readonly<Pick<z.infer<typeof listClaimsSchema>,
  'tenantId' | 'environmentId' | 'subjectCustomerId' | 'requestId'>>;
export type VerifyDeliveryReportAssertion = {
  (assertion: string | undefined, purpose: 'delivery_issue_report_create', request: { body: { order_reference: string; category: string }; idempotencyKey: string }): Promise<DeliveryCreateAccess>;
  (assertion: string | undefined, purpose: 'delivery_issue_report_replay', request: { body: { order_reference: string; category: string }; idempotencyKey: string }): Promise<DeliveryCreateAccess>;
  (assertion: string | undefined, purpose: 'delivery_issue_report_read', request: { reportId: string }): Promise<DeliveryReadAccess>;
  (assertion: string | undefined, purpose: 'delivery_issue_report_list'): Promise<DeliveryListAccess>;
};

export function createDeliveryReportAssertionVerifier(options: {
  secret: string; issuer: string; tenantId: string; environmentId: string; now?: () => Date;
}): VerifyDeliveryReportAssertion {
  if (Buffer.byteLength(options.secret) < 32) throw new Error('INVALID_DELIVERY_REPORT_AUTH_CONFIG');
  const key = new TextEncoder().encode(options.secret);
  const verify = async (assertion: string | undefined, purpose: 'delivery_issue_report_create' | 'delivery_issue_report_replay' | 'delivery_issue_report_read' | 'delivery_issue_report_list', request?: { body: { order_reference: string; category: string }; idempotencyKey: string } | { reportId: string }): Promise<DeliveryCreateAccess | DeliveryReadAccess | DeliveryListAccess> => {
    try {
      if (!assertion || assertion.length > 8192) throw new Error();
      const now = options.now?.() ?? new Date();
      const { payload } = await jwtVerify(assertion, key, {
        algorithms: ['HS256'], issuer: options.issuer, audience: 'human-operations-delivery-report',
        typ: 'cso-delivery-report+jwt', currentDate: now,
      });
      const claims = purpose === 'delivery_issue_report_create' ? createClaimsSchema.parse(payload)
        : purpose === 'delivery_issue_report_replay' ? replayClaimsSchema.parse(payload)
          : purpose === 'delivery_issue_report_read' ? readClaimsSchema.parse(payload) : listClaimsSchema.parse(payload);
      const nowSeconds = Math.floor(now.getTime() / 1000);
      if (claims.tenantId !== options.tenantId || claims.environmentId !== options.environmentId ||
          claims.purpose !== purpose || claims.iat > nowSeconds + 30 || claims.exp <= nowSeconds ||
          claims.exp <= claims.iat || claims.exp - claims.iat > 60) throw new Error();
      if (claims.purpose === 'delivery_issue_report_create' || claims.purpose === 'delivery_issue_report_replay') {
        if (!request || !('body' in request) || claims.orderReference !== request.body.order_reference ||
            claims.category !== request.body.category || claims.idempotencyKey !== request.idempotencyKey) throw new Error();
        const bodyDigest = createHash('sha256').update(JSON.stringify({
          order_reference: request.body.order_reference, category: request.body.category,
        })).digest();
        if (!timingSafeEqual(bodyDigest, Buffer.from(claims.bodySha256, 'hex'))) throw new Error();
        return {
          tenantId: claims.tenantId, environmentId: claims.environmentId,
          subjectCustomerId: claims.subjectCustomerId, conversationId: claims.conversationId,
          orderReference: claims.orderReference, category: claims.category,
          idempotencyKey: claims.idempotencyKey, requestId: claims.requestId,
        };
      }
      if (claims.purpose === 'delivery_issue_report_list') {
        if (request !== undefined) throw new Error();
        return { tenantId: claims.tenantId, environmentId: claims.environmentId,
          subjectCustomerId: claims.subjectCustomerId, requestId: claims.requestId };
      }
      if (!request || !('reportId' in request) || claims.reportId !== request.reportId) throw new Error();
      return { tenantId: claims.tenantId, environmentId: claims.environmentId,
        subjectCustomerId: claims.subjectCustomerId, reportId: claims.reportId, requestId: claims.requestId };
    } catch { throw new Error('DELIVERY_REPORT_UNAUTHORIZED'); }
  };
  return verify as VerifyDeliveryReportAssertion;
}
