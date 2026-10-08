import { z } from 'zod';
import { savedAddressStatusSchema, type GetSavedAddressStatus } from './saved-address-status.js';

const query = `query SavedAddressStatus($customerId: ID!) {
  activeChannel { code }
  customer(id: $customerId) {
    id
    addresses { defaultShippingAddress defaultBillingAddress }
  }
}`;

const providerResponseSchema = z.object({
  data: z.object({
    activeChannel: z.object({ code: z.string().min(1) }).strict(),
    customer: z.object({
      id: z.string().min(1),
      addresses: z.array(z.object({
        defaultShippingAddress: z.boolean(),
        defaultBillingAddress: z.boolean(),
      }).strict()).max(1000),
    }).strict(),
  }).strict(),
  errors: z.array(z.unknown()).max(0).optional(),
}).strict();

type Options = {
  adminApiUrl: string;
  apiKey: string;
  channelToken: string;
  expectedChannelCode: string;
  expectedTenantId: string;
  expectedEnvironmentId: string;
  fetcher?: typeof fetch;
};

export function createVendureSavedAddressStatusLookup(options: Options): GetSavedAddressStatus {
  return async (context) => {
    try {
      if (!options.channelToken.trim() || !options.expectedChannelCode.trim()
        || !options.expectedTenantId.trim() || !options.expectedEnvironmentId.trim()
        || context.tenantId !== options.expectedTenantId
        || context.environmentId !== options.expectedEnvironmentId) throw new Error('Unavailable');

      const response = await (options.fetcher ?? fetch)(options.adminApiUrl, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          'content-type': 'application/json',
          'vendure-api-key': options.apiKey,
          'vendure-token': options.channelToken,
        },
        body: JSON.stringify({ query, variables: { customerId: context.subjectCustomerId } }),
      });
      if (!response.ok) throw new Error('Unavailable');
      const { data } = providerResponseSchema.parse(await response.json());
      if (data.activeChannel.code !== options.expectedChannelCode
        || data.customer.id !== context.subjectCustomerId) throw new Error('Unavailable');

      const addresses = data.customer.addresses;
      const shippingDefaults = addresses.filter((value) => value.defaultShippingAddress).length;
      const billingDefaults = addresses.filter((value) => value.defaultBillingAddress).length;
      if (shippingDefaults > 1 || billingDefaults > 1) throw new Error('Unavailable');
      return savedAddressStatusSchema.parse({
        schemaVersion: '1',
        savedAddressCount: addresses.length,
        hasDefaultShippingAddress: shippingDefaults === 1,
        hasDefaultBillingAddress: billingDefaults === 1,
      });
    } catch {
      // Do not attach the original exception: it can contain provider PII or credentials.
      throw new Error('Saved address status is unavailable');
    }
  };
}
