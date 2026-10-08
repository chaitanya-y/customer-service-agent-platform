import type { DeliveryReport } from "./delivery-report";

export type DeliveryTransitionAction = "claim" | "acknowledge" | "close";

export type DeliveryTransitionAttempt = Readonly<{
  reportId: string;
  action: DeliveryTransitionAction;
  expectedVersion: number;
  idempotencyKey: string;
}>;

const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

/** A new sign-in or lost authorization cannot inherit another staff session's retries. */
export function clearDeliveryTransitionStorage(storage: Pick<Storage, "length" | "key" | "removeItem">): void {
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith("cso.delivery-report.transition:")) storage.removeItem(key);
  }
}

export function parseDeliveryTransitionAttempt(value: string | null, reportId: string): DeliveryTransitionAttempt | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const attempt = parsed as Record<string, unknown>;
    if (attempt.reportId !== reportId ||
        (attempt.action !== "claim" && attempt.action !== "acknowledge" && attempt.action !== "close") ||
        !Number.isSafeInteger(attempt.expectedVersion) || (attempt.expectedVersion as number) < 1 ||
        typeof attempt.idempotencyKey !== "string" || !idempotencyKeyPattern.test(attempt.idempotencyKey)) return undefined;
    return attempt as DeliveryTransitionAttempt;
  } catch { return undefined; }
}

export function nextDeliveryTransitionAttempt(
  pending: DeliveryTransitionAttempt | undefined,
  report: Pick<DeliveryReport, "reportId" | "version">,
  action: DeliveryTransitionAction,
  newKey: string,
): DeliveryTransitionAttempt {
  if (pending?.reportId === report.reportId && pending.action === action && pending.expectedVersion === report.version) return pending;
  return { reportId: report.reportId, action, expectedVersion: report.version, idempotencyKey: newKey };
}

export function transitionIsResolved(
  pending: DeliveryTransitionAttempt,
  report: Pick<DeliveryReport, "reportId" | "version" | "status">,
): boolean {
  return pending.reportId === report.reportId && report.version > pending.expectedVersion &&
    (pending.action === "claim" ? ["CLAIMED", "ACKNOWLEDGED", "REVIEW_CLOSED"].includes(report.status) :
      pending.action === "acknowledge" ? ["ACKNOWLEDGED", "REVIEW_CLOSED"].includes(report.status) : report.status === "REVIEW_CLOSED");
}

export type DeliveryDetailSnapshot<T extends { report: { reportId: string; version: number } }> = Readonly<{
  detail: T;
  sequence: number;
}>;

export function reconcileDeliveryDetail<T extends { report: { reportId: string; version: number } }>(
  current: DeliveryDetailSnapshot<T> | undefined,
  incoming: T,
  sequence: number,
): DeliveryDetailSnapshot<T> {
  if (current && current.detail.report.reportId === incoming.report.reportId &&
      (incoming.report.version < current.detail.report.version ||
        (incoming.report.version === current.detail.report.version && sequence < current.sequence))) return current;
  return { detail: incoming, sequence };
}
