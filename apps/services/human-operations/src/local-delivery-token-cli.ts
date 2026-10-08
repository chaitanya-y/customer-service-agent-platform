import { SignJWT } from 'jose';
import { z } from 'zod';

const config = z.object({
  HUMAN_ACCESS_HMAC_SECRET: z.string().min(32),
  HUMAN_ACCESS_ISSUER: z.string().min(1).default('customer-service-os-human-operations'),
  TENANT_ID: z.string().min(1),
  ENVIRONMENT_ID: z.string().min(1),
  LOCAL_DELIVERY_STAFF_ID: z.string().min(1).default('local-delivery-agent'),
  LOCAL_DELIVERY_STAFF_ROLE: z.enum(['DELIVERY_AGENT', 'DELIVERY_SUPERVISOR']).default('DELIVERY_AGENT'),
  LOCAL_DELIVERY_STAFF_TTL_SECONDS: z.coerce.number().int().min(60).max(2_592_000).default(2_592_000),
}).parse(process.env);

const token = await new SignJWT({
  staffId: config.LOCAL_DELIVERY_STAFF_ID,
  tenantId: config.TENANT_ID,
  environmentId: config.ENVIRONMENT_ID,
  role: config.LOCAL_DELIVERY_STAFF_ROLE,
})
  .setProtectedHeader({ alg: 'HS256', typ: 'cso-delivery-staff+jwt' })
  .setIssuer(config.HUMAN_ACCESS_ISSUER)
  .setAudience('human-operations-delivery-staff')
  .setIssuedAt()
  .setExpirationTime(`${config.LOCAL_DELIVERY_STAFF_TTL_SECONDS}s`)
  .sign(new TextEncoder().encode(config.HUMAN_ACCESS_HMAC_SECRET));

process.stdout.write(`${token}\n`);
