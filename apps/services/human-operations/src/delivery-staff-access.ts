import { jwtVerify } from 'jose';
import { z } from 'zod';

export const DELIVERY_STAFF_ASSERTION_HEADER = 'x-cso-delivery-staff-assertion';
const opaqueId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const claimsSchema = z.object({
  staffId: opaqueId, tenantId: opaqueId, environmentId: opaqueId,
  role: z.enum(['DELIVERY_AGENT', 'DELIVERY_SUPERVISOR']),
  iss: z.string(), aud: z.string(), iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
}).strict();
export type DeliveryStaffAccess = Readonly<Pick<z.infer<typeof claimsSchema>, 'staffId' | 'tenantId' | 'environmentId' | 'role'>>;
export type VerifyDeliveryStaffAssertion = (assertion: string | undefined) => Promise<DeliveryStaffAccess>;

export function createDeliveryStaffAssertionVerifier(options: {
  secret: string; issuer: string; tenantId: string; environmentId: string; now?: () => Date;
}): VerifyDeliveryStaffAssertion {
  if (Buffer.byteLength(options.secret) < 32) throw new Error('INVALID_DELIVERY_STAFF_AUTH_CONFIG');
  const key = new TextEncoder().encode(options.secret);
  return async (assertion) => {
    try {
      if (!assertion || assertion.length > 8192) throw new Error();
      const now = options.now?.() ?? new Date();
      const { payload } = await jwtVerify(assertion, key, {
        algorithms: ['HS256'], issuer: options.issuer, audience: 'human-operations-delivery-staff',
        typ: 'cso-delivery-staff+jwt', currentDate: now,
      });
      const claims = claimsSchema.parse(payload);
      const nowSeconds = Math.floor(now.getTime() / 1000);
      if (claims.tenantId !== options.tenantId || claims.environmentId !== options.environmentId ||
          claims.iat > nowSeconds + 30 || claims.exp <= nowSeconds || claims.exp <= claims.iat ||
          claims.exp - claims.iat > 2_592_000) throw new Error();
      return { staffId: claims.staffId, tenantId: claims.tenantId,
        environmentId: claims.environmentId, role: claims.role };
    } catch { throw new Error('DELIVERY_STAFF_UNAUTHORIZED'); }
  };
}
