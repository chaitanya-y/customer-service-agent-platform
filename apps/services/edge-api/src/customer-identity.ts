import { z } from 'zod';

export type AuthenticatedCustomer = {
  principalId: string;
  tenantId: string;
  environmentId: string;
  customerId: string;
};

const opaqueId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const authenticatedCustomerSchema = z
  .object({
    principalId: opaqueId,
    tenantId: opaqueId,
    environmentId: opaqueId,
    customerId: opaqueId,
  })
  .strict()
  .refine((identity) => identity.principalId === identity.customerId);

export function parseAuthenticatedCustomer(identity: unknown): AuthenticatedCustomer {
  return authenticatedCustomerSchema.parse(identity);
}

export type VerifyCustomerIdentity = (
  accessToken: string | undefined,
) => Promise<AuthenticatedCustomer>;

export class CustomerAuthenticationError extends Error {
  constructor() {
    super('Customer authentication is invalid');
    this.name = 'CustomerAuthenticationError';
  }
}
