import { jwtVerify } from 'jose';
import { z } from 'zod';

export const SUPPORT_STAFF_ASSERTION_HEADER = 'x-cso-support-staff-assertion';
const opaqueId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const claimsSchema = z.object({
  staffId: opaqueId, tenantId: opaqueId, environmentId: opaqueId,
  role: z.literal('SUPPORT_AGENT'), iss: z.string(), aud: z.string(),
  iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
}).strict();
export type SupportStaffAccess = Readonly<Pick<z.infer<typeof claimsSchema>, 'staffId'|'tenantId'|'environmentId'|'role'>>;
export type VerifySupportStaffAssertion = (assertion: string|undefined) => Promise<SupportStaffAccess>;
export function createSupportStaffAssertionVerifier(options: {
  secret: string; issuer: string; tenantId: string; environmentId: string; now?: () => Date;
}): VerifySupportStaffAssertion {
  if (Buffer.byteLength(options.secret)<32) throw new Error('INVALID_SUPPORT_STAFF_AUTH_CONFIG');
  const key = new TextEncoder().encode(options.secret);
  return async (assertion) => {
    try {
      if (!assertion || assertion.length>8192) throw new Error();
      const now = options.now?.() ?? new Date();
      const {payload} = await jwtVerify(assertion,key,{algorithms:['HS256'],issuer:options.issuer,
        audience:'human-operations-support-staff',typ:'cso-support-staff+jwt',currentDate:now});
      const claims = claimsSchema.parse(payload);
      const seconds = Math.floor(now.getTime()/1000);
      if (claims.tenantId!==options.tenantId || claims.environmentId!==options.environmentId ||
        claims.iat>seconds+30 || claims.exp<=seconds || claims.exp<=claims.iat || claims.exp-claims.iat>2592000) throw new Error();
      return {staffId:claims.staffId,tenantId:claims.tenantId,environmentId:claims.environmentId,role:claims.role};
    } catch { throw new Error('SUPPORT_STAFF_UNAUTHORIZED'); }
  };
}
