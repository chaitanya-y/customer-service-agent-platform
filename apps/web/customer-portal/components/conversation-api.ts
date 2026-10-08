import { getApiErrorMessage } from "./customer-api";

export type CustomerChatMessage = Readonly<{
  cancellationRequest?: CancellationRequest;
  createdAt?: string;
  messageId: string;
  refundWorkflow?: RefundWorkflowLink;
  sender: "assistant" | "customer" | "specialist";
  text: string;
}>;

export type CustomerConversation = Readonly<{
  conversationId: string;
  status: "OPEN" | "CLOSED";
  controlMode: "AI" | "QUEUED" | "HUMAN";
  controlVersion: number;
  handoffSessionId?: string;
  messages: readonly CustomerChatMessage[];
}>;

export type CustomerHandoff = Omit<CustomerConversation, "messages">;

export function getCustomerHandoffStatus(
  status: CustomerConversation["status"],
  controlMode: CustomerConversation["controlMode"],
): Readonly<{ label: string; detail: string }> | undefined {
  if (status === "CLOSED") return { label: "Conversation closed", detail: "This conversation has ended." };
  if (controlMode === "QUEUED") return {
    label: "Waiting for a specialist",
    detail: "You can keep writing here. A specialist will reply in this conversation.",
  };
  if (controlMode === "HUMAN") return {
    label: "Specialist connected",
    detail: "You are talking with a support specialist.",
  };
  return undefined;
}

export type RefundWorkflowLink = Readonly<{
  workflowId: string;
}>;

export type CancellationRequest = Readonly<{ orderReference: string }>;

export type CustomerConversationTurn = Readonly<{
  assistantMessage?: CustomerChatMessage;
  conversationId: string;
  customerMessageId: string;
  controlMode?: CustomerConversation["controlMode"];
  controlVersion?: number;
  refundWorkflow?: RefundWorkflowLink;
  cancellationRequest?: CancellationRequest;
}>;

type UnknownRecord = Record<string, unknown>;

const MAX_CUSTOMER_MESSAGE_LENGTH = 2_000;
const MAX_SAFE_TEXT_LENGTH = 8_000;

export class CustomerConversationApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CustomerConversationApiError";
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown, maxLength = MAX_SAFE_TEXT_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maxLength ? text : undefined;
}

function asIdentifier(value: unknown): string | undefined {
  const identifier = asText(value, 200);
  return identifier && /^[a-zA-Z0-9_-]+$/.test(identifier) ? identifier : undefined;
}

function asControlMode(value: unknown): CustomerConversation["controlMode"] | undefined {
  return value === "AI" || value === "QUEUED" || value === "HUMAN" ? value : undefined;
}

function asControlVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseControlState(data: UnknownRecord, allowCreateDefault = false): CustomerHandoff {
  const conversationId = parseConversationId(data);
  const status = data.status;
  const controlMode = asControlMode(data.control_mode ?? data.controlMode);
  const controlVersion = asControlVersion(data.control_version ?? data.controlVersion);
  const handoffSessionId = asIdentifier(data.handoff_session_id) ?? asIdentifier(data.handoffSessionId);
  if ((status !== "OPEN" && status !== "CLOSED") || !controlMode ||
      (!controlVersion && !allowCreateDefault) ||
      ((controlMode === "QUEUED" || controlMode === "HUMAN") && !handoffSessionId)) {
    throw new Error("The support service returned an invalid conversation state.");
  }
  return { conversationId, status, controlMode, controlVersion: controlVersion ?? 1,
    ...(handoffSessionId ? { handoffSessionId } : {}) };
}

function asData(value: unknown): UnknownRecord | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.data) ? value.data : value;
}

function asMessageText(value: UnknownRecord): string | undefined {
  const content = isRecord(value.content) ? value.content : undefined;
  const contentType = asText(content?.type, 32);

  if (content && contentType === "text") return asText(content.text);
  return asText(value.text);
}

function asMessageSender(value: unknown): CustomerChatMessage["sender"] | undefined {
  const sender = asText(value, 48)?.toLowerCase();

  if (
    sender === "customer"
    || sender === "customer_message"
    || sender === "end_customer"
  ) return "customer";
  if (sender === "assistant" || sender === "assistant_message") return "assistant";
  if (sender === "workforce" || sender === "specialist") return "specialist";
  return undefined;
}

function normalizeTranscriptMessage(value: unknown): CustomerChatMessage | undefined {
  if (!isRecord(value)) return undefined;

  const messageId = asIdentifier(value.message_id) ?? asIdentifier(value.messageId);
  const sender = asMessageSender(value.sender_kind) ?? asMessageSender(value.senderKind);
  const text = asMessageText(value);
  const createdAt = asText(value.created_at, 100) ?? asText(value.createdAt, 100);
  const workflow = isRecord(value.refund_workflow) ? value.refund_workflow : undefined;
  const workflowId = asIdentifier(workflow?.workflow_id) ?? asIdentifier(workflow?.workflowId);

  if (!messageId || !sender || !text) return undefined;
  return {
    messageId,
    sender,
    text,
    ...(createdAt ? { createdAt } : {}),
    ...(workflowId && sender === "assistant" ? { refundWorkflow: { workflowId } } : {}),
  };
}

function normalizeAssistantMessage(
  value: unknown,
  fallbackMessageId: string,
): CustomerChatMessage | undefined {
  if (!isRecord(value)) return undefined;

  const text = asMessageText(value);
  if (!text) return undefined;

  const messageId = asIdentifier(value.message_id) ?? asIdentifier(value.messageId) ?? fallbackMessageId;
  const createdAt = asText(value.created_at, 100) ?? asText(value.createdAt, 100);
  return { messageId, sender: "assistant", text, ...(createdAt ? { createdAt } : {}) };
}

function parseConversationId(value: UnknownRecord): string {
  const conversationId = asIdentifier(value.conversation_id) ?? asIdentifier(value.conversationId);
  if (!conversationId) throw new Error("The conversation response was not valid.");
  return conversationId;
}

function parseResponseBody(value: unknown): UnknownRecord {
  const payload = asData(value);
  if (!payload) throw new Error("The support service returned an invalid response.");
  return payload;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

export function parseCustomerConversation(payload: unknown): CustomerConversation {
  const data = parseResponseBody(payload);
  const control = parseControlState(data);
  const messages = Array.isArray(data.messages)
    ? data.messages.flatMap((message) => {
      const normalized = normalizeTranscriptMessage(message);
      return normalized ? [normalized] : [];
    })
    : [];

  return { ...control, messages };
}

export function parseCustomerConversationCreated(payload: unknown): CustomerConversation {
  const data = parseResponseBody(payload);
  return { ...parseControlState(data, true), messages: [] };
}

export function parseCustomerHandoff(payload: unknown, expectedControlVersion: number): CustomerHandoff {
  const data = parseResponseBody(payload);
  const state = parseControlState(data);
  if (state.status !== "OPEN" || state.controlMode === "AI" ||
      state.controlVersion <= expectedControlVersion) {
    throw new Error("The support service returned an invalid handoff response.");
  }
  return state;
}

export function parseCustomerConversationTurn(payload: unknown): CustomerConversationTurn {
  const data = parseResponseBody(payload);
  const conversationId = parseConversationId(data);
  const customerMessageId = asIdentifier(data.customer_message_id) ?? asIdentifier(data.customerMessageId);
  if (!customerMessageId) throw new Error("The support service did not confirm your message.");

  const workflow = isRecord(data.refund_workflow) ? data.refund_workflow : undefined;
  const workflowId = asIdentifier(workflow?.workflow_id) ?? asIdentifier(workflow?.workflowId);
  const cancellation = isRecord(data.cancellation_request) ? data.cancellation_request : undefined;
  const cancellationReference = asText(cancellation?.order_reference, 100);
  const assistantMessage = normalizeAssistantMessage(
    data.assistant_message ?? data.assistantMessage,
    `assistant-${customerMessageId}`,
  );

  return {
    conversationId,
    customerMessageId,
    ...(asControlMode(data.control_mode ?? data.controlMode)
      ? { controlMode: asControlMode(data.control_mode ?? data.controlMode) } : {}),
    ...(asControlVersion(data.control_version ?? data.controlVersion)
      ? { controlVersion: asControlVersion(data.control_version ?? data.controlVersion) } : {}),
    ...(assistantMessage ? { assistantMessage } : {}),
    ...(workflowId ? { refundWorkflow: { workflowId } } : {}),
    ...(cancellationReference && /^[A-Za-z0-9][A-Za-z0-9-]{7,99}$/.test(cancellationReference)
      ? { cancellationRequest: { orderReference: cancellationReference } } : {}),
  };
}

export async function requestHumanHandoff(input: Readonly<{
  conversationId: string;
  expectedControlVersion: number;
  idempotencyKey: string;
}>): Promise<CustomerHandoff> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(input.conversationId)}/handoff`, {
    body: JSON.stringify({ expected_control_version: input.expectedControlVersion }),
    headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
    method: "POST",
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new CustomerConversationApiError(
      getApiErrorMessage(body, "We could not request a support specialist. Please try again."),
      response.status,
    );
  }
  const handoff = parseCustomerHandoff(body, input.expectedControlVersion);
  if (handoff.conversationId !== input.conversationId) {
    throw new Error("The support service returned an invalid handoff response.");
  }
  return handoff;
}

export async function createCustomerConversation(idempotencyKey: string): Promise<CustomerConversation> {
  const response = await fetch("/api/conversations", {
    body: "{}",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    method: "POST",
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new CustomerConversationApiError(
      getApiErrorMessage(body, "We could not start a support conversation. Please try again."),
      response.status,
    );
  }
  return parseCustomerConversationCreated(body);
}

export async function loadCustomerConversation(conversationId: string): Promise<CustomerConversation> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    cache: "no-store",
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new CustomerConversationApiError(
      getApiErrorMessage(body, "We could not load this conversation. Please try again."),
      response.status,
    );
  }
  return parseCustomerConversation(body);
}

export async function sendCustomerMessage(input: Readonly<{
  clientMessageId: string;
  conversationId: string;
  idempotencyKey: string;
  orderReference?: string;
  text: string;
}>): Promise<CustomerConversationTurn> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(input.conversationId)}/messages`, {
    body: JSON.stringify({
      client_message_id: input.clientMessageId,
      content: { type: "text", text: input.text },
      ...(input.orderReference ? { order_reference: input.orderReference } : {}),
    }),
    headers: {
      "content-type": "application/json",
      "idempotency-key": input.idempotencyKey,
    },
    method: "POST",
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new CustomerConversationApiError(
      getApiErrorMessage(body, "We could not send your message. Please try again."),
      response.status,
    );
  }
  return parseCustomerConversationTurn(body);
}

export function isValidCustomerMessage(value: string): boolean {
  return value.trim().length > 0 && value.trim().length <= MAX_CUSTOMER_MESSAGE_LENGTH;
}

export { MAX_CUSTOMER_MESSAGE_LENGTH };
