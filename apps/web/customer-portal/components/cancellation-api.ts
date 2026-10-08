export type CancellationStage =
  | "EVALUATING"
  | "FACTS_UNAVAILABLE"
  | "NOT_ELIGIBLE"
  | "AWAITING_CUSTOMER_CONFIRMATION"
  | "PREVIEW_EXPIRED"
  | "CUSTOMER_DECLINED"
  | "PREVIEW_INVALIDATED"
  | "CANCELLATION_REQUESTED"
  | "PENDING_RECONCILIATION"
  | "ORDER_CANCELLED"
  | "CANCELLATION_FAILED";

export type CancellationPreview = Readonly<{
  preview_id: string;
  order_reference: string;
  placed_at: string;
  valid_until: string;
  total: Readonly<{ amount_minor: 0; currency: string }>;
  lines: readonly Readonly<{ item_id: string; quantity: number; display_name?: string }>[];
}>;

export type CancellationState = Readonly<{
  stage: CancellationStage;
  title: string;
  detail: string;
  canDecide: boolean;
  isTerminal: boolean;
  preview?: CancellationPreview;
}>;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum = 200): string | undefined {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maximum
    ? value : undefined;
}

function dateTime(value: unknown): string | undefined {
  const candidate = text(value, 100);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}

function parsePreview(value: unknown): CancellationPreview {
  if (!isRecord(value) || !isRecord(value.total) || !Array.isArray(value.lines)) {
    throw new Error("The cancellation preview was not valid.");
  }
  const previewId = text(value.preview_id);
  const orderReference = text(value.order_reference, 100);
  const placedAt = dateTime(value.placed_at);
  const validUntil = dateTime(value.valid_until);
  const currency = text(value.total.currency, 3);
  if (!previewId || !orderReference || !placedAt || !validUntil
    || value.total.amount_minor !== 0 || !currency || !/^[A-Z]{3}$/.test(currency)
    || value.lines.length < 1 || value.lines.length > 100) {
    throw new Error("The cancellation preview was not valid.");
  }
  const lines = value.lines.map((line) => {
    if (!isRecord(line) || !text(line.item_id)
      || typeof line.quantity !== "number" || !Number.isSafeInteger(line.quantity)
      || line.quantity < 1) throw new Error("The cancellation preview was not valid.");
    const displayName = line.display_name === undefined ? undefined : text(line.display_name, 300);
    if (line.display_name !== undefined && (!displayName
      || /\p{C}/u.test(displayName) || !/[\p{L}\p{N}]/u.test(displayName))) {
      throw new Error("The cancellation preview was not valid.");
    }
    return { item_id: line.item_id as string, quantity: line.quantity,
      ...(displayName === undefined ? {} : { display_name: displayName }) };
  });
  return {
    preview_id: previewId,
    order_reference: orderReference,
    placed_at: placedAt,
    valid_until: validUntil,
    total: { amount_minor: 0, currency },
    lines,
  };
}

const stageCopy: Record<CancellationStage, Readonly<{ title: string; detail: string; terminal: boolean }>> = {
  EVALUATING: { title: "Checking your order", detail: "We are checking whether this order can be cancelled.", terminal: false },
  FACTS_UNAVAILABLE: { title: "Order details unavailable", detail: "We could not verify the current order details. No cancellation was requested.", terminal: true },
  NOT_ELIGIBLE: { title: "Order cannot be cancelled here", detail: "This order is not eligible for this cancellation option. Contact support if you need help.", terminal: true },
  AWAITING_CUSTOMER_CONFIRMATION: { title: "Review order cancellation", detail: "Check this exact order before you decide. The order is not cancelled yet.", terminal: false },
  PREVIEW_EXPIRED: { title: "Cancellation review expired", detail: "This preview is no longer available. No cancellation was requested.", terminal: true },
  CUSTOMER_DECLINED: { title: "Cancellation declined", detail: "You declined this cancellation preview. No cancellation was requested.", terminal: true },
  PREVIEW_INVALIDATED: { title: "Order details changed", detail: "The order changed after the preview. No cancellation was requested.", terminal: true },
  CANCELLATION_REQUESTED: { title: "Cancellation requested", detail: "We received your confirmation and are checking the order outcome. It is not confirmed cancelled yet.", terminal: false },
  PENDING_RECONCILIATION: { title: "Cancellation requested", detail: "We are verifying the order outcome. Please check this page for an update.", terminal: false },
  ORDER_CANCELLED: { title: "Order cancelled", detail: "The order cancellation has been confirmed.", terminal: true },
  CANCELLATION_FAILED: { title: "Cancellation needs attention", detail: "We could not confirm the order was cancelled. Please contact support.", terminal: true },
};

export function parseCancellationState(value: unknown): CancellationState {
  if (!isRecord(value) || typeof value.stage !== "string"
    || !Object.prototype.hasOwnProperty.call(stageCopy, value.stage)) {
    throw new Error("The cancellation status response was not valid.");
  }
  const stage = value.stage as CancellationStage;
  const copy = stageCopy[stage];
  const preview = stage === "AWAITING_CUSTOMER_CONFIRMATION" ? parsePreview(value.preview) : undefined;
  return {
    stage, title: copy.title, detail: copy.detail, isTerminal: copy.terminal,
    canDecide: stage === "AWAITING_CUSTOMER_CONFIRMATION" && preview !== undefined,
    ...(preview ? { preview } : {}),
  };
}

export class CancellationApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CancellationApiError";
  }
}

async function responseError(response: Response, fallback: string): Promise<CancellationApiError> {
  const body: unknown = await response.json().catch(() => undefined);
  const message = isRecord(body) && isRecord(body.error) ? text(body.error.message, 500) : undefined;
  return new CancellationApiError(message ?? fallback, response.status);
}

export async function getCancellationStatus(workflowId: string): Promise<CancellationState> {
  const response = await fetch(`/api/cancellations/${encodeURIComponent(workflowId)}`, {
    method: "GET", cache: "no-store",
  });
  if (!response.ok) throw await responseError(response, "We could not load your cancellation status.");
  return parseCancellationState(await response.json());
}

export async function sendCancellationDecision(
  workflowId: string, previewId: string, accepted: boolean,
): Promise<void> {
  const response = await fetch(`/api/cancellations/${encodeURIComponent(workflowId)}/confirmation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preview_id: previewId, accepted }),
  });
  if (response.status !== 202) throw await responseError(response, "We could not record your decision. Please try again.");
  const body: unknown = await response.json().catch(() => undefined);
  if (!isRecord(body) || body.status !== "confirmation_received") {
    throw new Error("We could not verify your decision was received. Please refresh the status.");
  }
}

export async function startCancellationReview(orderReference: string): Promise<string> {
  const response = await fetch("/api/cancellations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order_reference: orderReference }),
  });
  if (response.status !== 202) throw await responseError(response, "We could not start your cancellation review. Please try again.");
  const body: unknown = await response.json().catch(() => undefined);
  if (!isRecord(body) || typeof body.workflow_id !== "string" || !/^cancel-[a-f0-9]{64}$/.test(body.workflow_id)) {
    throw new Error("We could not verify the cancellation review link. Please try again.");
  }
  return `/cancellations/${encodeURIComponent(body.workflow_id)}`;
}
