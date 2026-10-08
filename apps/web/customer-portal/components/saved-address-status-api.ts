export type SavedAddressStatus = Readonly<{
  schemaVersion: "1";
  savedAddressCount: number;
  hasDefaultShippingAddress: boolean;
  hasDefaultBillingAddress: boolean;
}>;

export class SavedAddressStatusApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 401 || status === 403
      ? "Please sign in again to check your saved addresses."
      : "We could not check your saved addresses. Please try again.");
    this.name = "SavedAddressStatusApiError";
    this.status = status;
  }
}

export function parseSavedAddressStatus(value: unknown): SavedAddressStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Saved-address status is not valid.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 4
    || record.schemaVersion !== "1"
    || typeof record.savedAddressCount !== "number"
    || !Number.isSafeInteger(record.savedAddressCount)
    || record.savedAddressCount < 0
    || record.savedAddressCount > 1000
    || typeof record.hasDefaultShippingAddress !== "boolean"
    || typeof record.hasDefaultBillingAddress !== "boolean"
    || (record.savedAddressCount === 0
      && (record.hasDefaultShippingAddress || record.hasDefaultBillingAddress))) {
    throw new Error("Saved-address status is not valid.");
  }
  return {
    schemaVersion: "1",
    savedAddressCount: record.savedAddressCount,
    hasDefaultShippingAddress: record.hasDefaultShippingAddress,
    hasDefaultBillingAddress: record.hasDefaultBillingAddress,
  };
}

export async function loadSavedAddressStatus(): Promise<SavedAddressStatus> {
  let response: Response;
  try {
    response = await fetch("/api/account/saved-address-status", {
      method: "GET", cache: "no-store",
    });
  } catch {
    throw new SavedAddressStatusApiError(503);
  }
  if (response.status !== 200) throw new SavedAddressStatusApiError(response.status);
  try {
    return parseSavedAddressStatus(await response.json());
  } catch {
    throw new SavedAddressStatusApiError(response.status);
  }
}
