import { SignJWT } from 'jose';
import { z } from 'zod';

const config=z.object({
  HUMAN_ACCESS_HMAC_SECRET:z.string().min(32),
  HUMAN_ACCESS_ISSUER:z.string().min(1).default('customer-service-os-human-operations'),
  TENANT_ID:z.string().min(1),ENVIRONMENT_ID:z.string().min(1),
  LOCAL_SUPPORT_STAFF_ID:z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).default('local-support-agent'),
  LOCAL_SUPPORT_STAFF_TTL_SECONDS:z.coerce.number().int().min(60).max(2592000).default(2592000),
}).parse(process.env);
const token=await new SignJWT({staffId:config.LOCAL_SUPPORT_STAFF_ID,tenantId:config.TENANT_ID,
  environmentId:config.ENVIRONMENT_ID,role:'SUPPORT_AGENT'})
  .setProtectedHeader({alg:'HS256',typ:'cso-support-staff+jwt'})
  .setIssuer(config.HUMAN_ACCESS_ISSUER).setAudience('human-operations-support-staff')
  .setIssuedAt().setExpirationTime(`${config.LOCAL_SUPPORT_STAFF_TTL_SECONDS}s`)
  .sign(new TextEncoder().encode(config.HUMAN_ACCESS_HMAC_SECRET));
process.stdout.write(`${token}\n`);
