import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const require = createRequire(import.meta.url);
function api() {
  const file = fileURLToPath(new URL("../components/conversation-api.ts", import.meta.url));
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(
    (specifier) => specifier === "./customer-api"
      ? { getApiErrorMessage: () => "The request failed." }
      : require(specifier),
    module, module.exports,
  );
  return module.exports;
}
const conversationId = "f38f8a3f-c1a2-4f53-94ac-bdb19d441674";
const sessionId = "9279888d-c449-4fe9-b68d-a030401d84bb";

test("parses control state and specialist messages in the customer transcript", async () => {
  const { parseCustomerConversation } = await api();
  assert.deepEqual(parseCustomerConversation({
    conversation_id: conversationId, status: "OPEN", control_mode: "HUMAN",
    control_version: 4, handoff_session_id: sessionId,
    messages: [{ message_id: "staff-message-1", sender_kind: "WORKFORCE",
      content: { type: "text", text: "I can help with your order." } }],
  }), {
    conversationId, status: "OPEN", controlMode: "HUMAN",
    controlVersion: 4, handoffSessionId: sessionId,
    messages: [{ messageId: "staff-message-1", sender: "specialist", text: "I can help with your order." }],
  });
});

test("requests handoff with a version bound idempotent customer call", async () => {
  const { requestHumanHandoff } = await api();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ conversation_id: conversationId, status: "OPEN", control_mode: "QUEUED",
      control_version: 2, handoff_session_id: sessionId });
  };
  const result = await requestHumanHandoff({ conversationId, expectedControlVersion: 1,
    idempotencyKey: "5b396ac4-a6f0-4259-990e-2846809522e9" });
  assert.deepEqual(result, { conversationId, status: "OPEN", controlMode: "QUEUED",
    controlVersion: 2, handoffSessionId: sessionId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/conversations/${conversationId}/handoff`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { expected_control_version: 1 });
  assert.equal(calls[0].init.headers["idempotency-key"], "5b396ac4-a6f0-4259-990e-2846809522e9");
});

test("rejects malformed or failed handoff and does not claim a specialist is connected", async () => {
  const { requestHumanHandoff, CustomerConversationApiError } = await api();
  const input = { conversationId, expectedControlVersion: 1,
    idempotencyKey: "5b396ac4-a6f0-4259-990e-2846809522e9" };
  globalThis.fetch = async () => Response.json({ conversation_id: conversationId, status: "OPEN",
    control_mode: "AI", control_version: 1 }, { status: 200 });
  await assert.rejects(requestHumanHandoff(input), /invalid/i);
  globalThis.fetch = async () => Response.json({ error: { message: "State changed" } }, { status: 409 });
  await assert.rejects(requestHumanHandoff(input), (error) => {
    assert.ok(error instanceof CustomerConversationApiError);
    assert.equal(error.status, 409);
    return true;
  });
});

test("queued customer message is an accepted receipt, not a clarification from AI", async () => {
  const { parseCustomerConversationTurn } = await api();
  assert.deepEqual(parseCustomerConversationTurn({ conversation_id: conversationId,
    customer_message_id: "customer-message-1", control_mode: "QUEUED", control_version: 2 }), {
    conversationId, customerMessageId: "customer-message-1", controlMode: "QUEUED", controlVersion: 2,
  });
});

test("typed cancellation intent becomes a review action without a workflow start", async () => {
  const { parseCustomerConversationTurn } = await api();
  const turn = parseCustomerConversationTurn({ conversation_id: conversationId,
    customer_message_id: "customer-message-1",
    assistant_message: { message_id: "assistant-message-1", content: { type: "text", text: "You can review cancellation." } },
    cancellation_request: { order_reference: "ORDER-12345" },
  });
  assert.deepEqual(turn.cancellationRequest, { orderReference: "ORDER-12345" });
  assert.equal(turn.refundWorkflow, undefined);
  assert.equal(turn.assistantMessage.text, "You can review cancellation.");
  assert.equal(parseCustomerConversationTurn({ conversation_id: conversationId,
    customer_message_id: "customer-message-2", cancellation_request: { order_reference: "bad ref" },
  }).cancellationRequest, undefined);
});

test("handoff status copy distinguishes queued, connected, returned, and closed states", async () => {
  const { getCustomerHandoffStatus } = await api();
  assert.deepEqual(getCustomerHandoffStatus("OPEN", "QUEUED"), {
    label: "Waiting for a specialist", detail: "You can keep writing here. A specialist will reply in this conversation."
  });
  assert.deepEqual(getCustomerHandoffStatus("OPEN", "HUMAN"), {
    label: "Specialist connected", detail: "You are talking with a support specialist."
  });
  assert.equal(getCustomerHandoffStatus("OPEN", "AI"), undefined);
  assert.deepEqual(getCustomerHandoffStatus("CLOSED", "AI"), {
    label: "Conversation closed", detail: "This conversation has ended."
  });
});
