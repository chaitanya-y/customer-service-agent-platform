import { z } from 'zod';

import {
  PRODUCT_CATALOG_MAX_MATCHES,
  PRODUCT_CATALOG_MAX_SEARCH_ROWS,
  PRODUCT_CATALOG_MAX_VARIANTS_PER_PRODUCT,
  projectCatalogSearchResults,
  type CatalogSearchResult,
  type ProductCatalogClient,
  type ProductCatalogResult,
} from './product-catalog.js';

const searchProductsQuery = `
  query SearchProducts($input: SearchInput!) {
    activeChannel { code }
    search(input: $input) {
      totalItems
      items {
        productId
        productName
        description
        productVariantName
        inStock
        currencyCode
        priceWithTax {
          __typename
          ... on SinglePrice { value }
        }
      }
    }
  }
`;

const shopSearchResultSchema = z.object({
  productId: z.string().min(1),
  productName: z.string().min(1).max(300),
  description: z.string().max(4_000),
  productVariantName: z.string().min(1).max(300),
  inStock: z.boolean(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  priceWithTax: z.discriminatedUnion('__typename', [
    z.object({
      __typename: z.literal('SinglePrice'),
      value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    }),
    z.object({
      __typename: z.literal('PriceRange'),
    }),
  ]),
});

const shopSearchResponseSchema = z.object({
  data: z.object({
    activeChannel: z.object({ code: z.string().trim().min(1) }),
    search: z.object({
      totalItems: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      items: z.array(shopSearchResultSchema),
    }),
  }).optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type VendureCatalogClientOptions = {
  shopApiUrl: string;
  channelToken: string;
  expectedChannelCode: string;
  fetcher?: Fetcher;
};

function boundedResultLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Product catalog limit must be a positive integer');
  }

  return Math.min(limit, PRODUCT_CATALOG_MAX_MATCHES);
}

function searchRowLimit(limit: number): number {
  return Math.min(
    boundedResultLimit(limit) * PRODUCT_CATALOG_MAX_VARIANTS_PER_PRODUCT,
    PRODUCT_CATALOG_MAX_SEARCH_ROWS,
  );
}

async function readShopSearchResponse(
  fetcher: Fetcher,
  options: VendureCatalogClientOptions,
  query: string,
  limit: number,
): Promise<CatalogSearchResult[]> {
  let response: Response;
  try {
    response = await fetcher(options.shopApiUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'vendure-token': options.channelToken,
      },
      body: JSON.stringify({
        query: searchProductsQuery,
        variables: {
          input: {
            term: query,
            take: limit,
            groupByProduct: false,
          },
        },
      }),
    });
  } catch {
    throw new Error('Vendure catalog request failed');
  }

  if (!response.ok) {
    throw new Error(`Vendure catalog request failed with HTTP status ${response.status}`);
  }

  let rawPayload: unknown;
  try {
    rawPayload = await response.json();
  } catch {
    throw new Error('Vendure catalog returned invalid GraphQL data');
  }

  const parsed = shopSearchResponseSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new Error('Vendure catalog returned invalid GraphQL data');
  }
  if (parsed.data.errors?.length || !parsed.data.data) {
    throw new Error('Vendure catalog returned a GraphQL error');
  }

  if (parsed.data.data.activeChannel.code !== options.expectedChannelCode) {
    throw new Error('Product catalog is unavailable');
  }
  if (parsed.data.data.search.totalItems !== parsed.data.data.search.items.length) {
    throw new Error('Vendure catalog returned an incomplete search result');
  }

  return parsed.data.data.search.items;
}

export function createVendureCatalogClient({
  shopApiUrl,
  channelToken,
  expectedChannelCode,
  fetcher = fetch,
}: VendureCatalogClientOptions): ProductCatalogClient {
  return {
    async searchPublishedProducts(
      query: string,
      limit: number,
    ): Promise<ProductCatalogResult> {
      const results = await readShopSearchResponse(
        fetcher,
        { shopApiUrl, channelToken, expectedChannelCode },
        query,
        searchRowLimit(limit),
      );
      return projectCatalogSearchResults(results);
    },
  };
}
