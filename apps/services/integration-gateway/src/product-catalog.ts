import type { OrderAccessContext } from './trusted-context.js';

export const PRODUCT_CATALOG_MAX_MATCHES = 5;
export const PRODUCT_CATALOG_MAX_VARIANTS_PER_PRODUCT = 100;
export const PRODUCT_CATALOG_MAX_SEARCH_ROWS =
  PRODUCT_CATALOG_MAX_MATCHES * PRODUCT_CATALOG_MAX_VARIANTS_PER_PRODUCT;

export type ProductCatalogResult = {
  schemaVersion: 1;
  matches: Array<{
    name: string;
    description: string;
    variants: Array<{
      name: string;
      availability?: 'IN_STOCK' | 'OUT_OF_STOCK';
      price?: {
        amountMinor: number;
        currency: string;
      };
    }>;
    availability?: 'IN_STOCK' | 'OUT_OF_STOCK';
  }>;
};

export type CatalogSearchResult = {
  productId: string;
  productName: string;
  description: string;
  productVariantName: string;
  inStock: boolean;
  currencyCode: string;
  priceWithTax:
    | { __typename: 'SinglePrice'; value: number }
    | { __typename: 'PriceRange' };
};

export type ProductCatalogClient = {
  searchPublishedProducts(
    query: string,
    limit: number,
  ): Promise<ProductCatalogResult>;
};

export type TrustedAccessContext = Pick<OrderAccessContext, 'tenantId'>;

export function projectCatalogSearchResults(
  results: readonly CatalogSearchResult[],
): ProductCatalogResult {
  const matchesByProductId = new Map<
    string,
    ProductCatalogResult['matches'][number]
  >();
  const variantRowsByProductId = new Map<string, number>();

  for (const result of results) {
    const variantRows = (variantRowsByProductId.get(result.productId) ?? 0) + 1;
    variantRowsByProductId.set(result.productId, variantRows);
    if (variantRows > PRODUCT_CATALOG_MAX_VARIANTS_PER_PRODUCT) {
      throw new Error('Product catalog returned too many product variants');
    }
    if (typeof result.inStock !== 'boolean') {
      throw new Error('Product catalog returned invalid variant stock status');
    }
    let match = matchesByProductId.get(result.productId);
    if (!match) {
      if (matchesByProductId.size === PRODUCT_CATALOG_MAX_MATCHES) {
        continue;
      }
      match = {
        name: result.productName,
        description: result.description,
        variants: [],
      };
      matchesByProductId.set(result.productId, match);
    }

    if (match.variants.length < PRODUCT_CATALOG_MAX_VARIANTS_PER_PRODUCT) {
      match.variants.push({
        name: result.productVariantName,
        availability: result.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
        ...(result.priceWithTax.__typename === 'SinglePrice'
          ? {
              price: {
                amountMinor: result.priceWithTax.value,
                currency: result.currencyCode,
              },
            }
          : {}),
      });
    }
  }

  return {
    schemaVersion: 1,
    matches: Array.from(matchesByProductId.values()),
  };
}

type GetProductCatalogDependencies = {
  catalogClient: ProductCatalogClient;
  expectedTenantId: string;
  channelToken?: string;
  expectedChannelCode?: string;
};

export function createGetProductCatalog({
  catalogClient,
  expectedTenantId,
  channelToken,
  expectedChannelCode,
}: GetProductCatalogDependencies) {
  return async function getProductCatalog(
    query: string,
    accessContext: TrustedAccessContext,
  ): Promise<ProductCatalogResult> {
    if (
      !channelToken?.trim() ||
      !expectedChannelCode?.trim() ||
      accessContext.tenantId !== expectedTenantId
    ) {
      throw new Error('Product catalog is unavailable');
    }

    return catalogClient.searchPublishedProducts(
      query,
      PRODUCT_CATALOG_MAX_MATCHES,
    );
  };
}

export type GetProductCatalog = ReturnType<typeof createGetProductCatalog>;
