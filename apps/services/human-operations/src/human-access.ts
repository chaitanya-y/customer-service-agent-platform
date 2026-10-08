import { jwtVerify } from 'jose';
import { z } from 'zod';

export const HUMAN_ASSERTION_HEADER = 'x-cso-human-assertion';
const claimsSchema = z.object({ staffId: z.string().min(1), tenantId: z.string().min(1), environmentId: z.string().min(1), role: z.enum(['REFUND_APPROVER', 'REFUND_SUPERVISOR']), iss: z.string(), aud: z.string(), iat: z.number().int().nonnegative(), exp: z.number().int().positive() }).strict();
export type HumanAccess = z.infer<typeof claimsSchema>;
export function createHumanAssertionVerifier(options: { secret: string; issuer: string; audience: string; tenantId: string; environmentId: string; now?: () => Date }) {
  const key = new TextEncoder().encode(options.secret);
  return async (assertion: string | undefined): Promise<HumanAccess> => {
    if (!assertion) throw new Error('HUMAN_UNAUTHORIZED');
    try {
      const now = options.now?.() ?? new Date();
      const { payload } = await jwtVerify(assertion, key, { algorithms: ['HS256'], issuer: options.issuer, audience: options.audience, typ: 'cso-human+jwt', currentDate: now });
      const claims = claimsSchema.parse(payload);
      const nowSeconds = Math.floor(now.getTime() / 1000);
      if (claims.tenantId !== options.tenantId || claims.environmentId !== options.environmentId ||
          claims.iat > nowSeconds + 30 || claims.exp <= nowSeconds || claims.exp <= claims.iat ||
          claims.exp - claims.iat > 2_592_000) throw new Error();
      return claims;
    } catch { throw new Error('HUMAN_UNAUTHORIZED'); }
  };
}
