export type RecentOrderReferences = Readonly<{
  schemaVersion: "1";
  orders: readonly Readonly<{ reference: string; placedAt: string }>[];
  hasMore: boolean;
}>;

export class RecentOrderReferencesApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 401 || status === 403
      ? "Please sign in again to find your recent orders."
      : "We could not find your recent orders. Please try again.");
    this.name = "RecentOrderReferencesApiError";
    this.status = status;
  }
}

function isPlacementDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return false;
  const calendarDate = new Date(value.slice(0, 10) + "T00:00:00Z");
  return Number.isFinite(Date.parse(value)) && Number.isFinite(calendarDate.getTime())
    && calendarDate.toISOString().slice(0, 10) === value.slice(0, 10);
}

export function parseRecentOrderReferences(value: unknown): RecentOrderReferences {
  const invalid = () => new Error("Recent-order references are not valid.");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || record.schemaVersion !== "1"
    || !Array.isArray(record.orders) || record.orders.length > 10 || typeof record.hasMore !== "boolean"
    || (record.hasMore && record.orders.length !== 10)) throw invalid();
  const references = new Set<string>();
  const orders = record.orders.map((value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
    const order = value as Record<string, unknown>;
    if (Object.keys(order).length !== 2 || typeof order.reference !== "string"
      || order.reference.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(order.reference)
      || !isPlacementDate(order.placedAt) || references.has(order.reference)) throw invalid();
    references.add(order.reference);
    return { reference: order.reference, placedAt: order.placedAt };
  });
  if (!orders.every((order, index) => index === 0 || Date.parse(orders[index - 1].placedAt) >= Date.parse(order.placedAt))) throw invalid();
  return { schemaVersion: "1", orders, hasMore: record.hasMore };
}

export async function loadRecentOrderReferences(): Promise<RecentOrderReferences> {
  let response: Response;
  try { response = await fetch("/api/account/recent-order-references", { method: "GET", cache: "no-store" }); }
  catch { throw new RecentOrderReferencesApiError(503); }
  if (response.status !== 200) throw new RecentOrderReferencesApiError(response.status);
  try { return parseRecentOrderReferences(await response.json()); }
  catch { throw new RecentOrderReferencesApiError(503); }
}
