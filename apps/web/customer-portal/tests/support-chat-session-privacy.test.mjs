import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });

function load(path, dependencies) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(dependencies, module, module.exports);
  return module.exports;
}

function harness(handoffAvailable = true) {
  const slots = [];
  const effects = [];
  const listeners = new Map();
  const storage = new Map();
  let cursor = 0;
  let mounted = false;
  globalThis.window = {
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: key => { storage.delete(key); },
    },
    addEventListener: (name, listener) => { listeners.set(name, listener); },
    removeEventListener: (name) => { listeners.delete(name); },
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const hooks = {
    ...require("react"),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: callback => callback,
    useEffect(effect) { if (!mounted) effects.push(effect); },
  };
  const customerApi = load("../components/customer-api.ts", require);
  const conversationApi = load("../components/conversation-api.ts", name => name === "./customer-api" ? customerApi : require(name));
  const session = load("../components/customer-session-state.ts", require);
  const { SupportChat } = load("../components/support-chat.tsx", name => {
    if (name === "react") return hooks;
    if (name === "./conversation-api") return conversationApi;
    if (name === "./customer-session-state") return session;
    if (name === "./recent-order-references-api") return load("../components/recent-order-references-api.ts", require);
    if (name === "./saved-address-status-api") return load("../components/saved-address-status-api.ts", require);
    if (name.endsWith(".css")) return { default: {} };
    if (name.startsWith("./")) return {};
    return require(name);
  });
  const find = predicate => {
    cursor = 0;
    const visit = element => {
      if (!element || typeof element !== "object") return;
      if (predicate(element)) return element;
      for (const child of [element.props?.children].flat(Infinity)) {
        const found = visit(child);
        if (found) return found;
      }
    };
    return visit(SupportChat({ handoffAvailable }));
  };
  find(() => false);
  mounted = true;
  for (const effect of effects) effect();
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const setSession = () => {
    slots[0] = conversationId;
    slots[1] = { conversationId, status: "OPEN", controlMode: "AI", controlVersion: 1 };
    slots[2] = [{ messageId: "message-1", sender: "assistant", text: "Private order information" }];
    storage.set("cso.current-conversation-id", conversationId);
  };
  return { slots, storage, listeners, find, setSession, conversationId };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

test("message authentication failure clears the transcript and stored conversation", async () => {
  const state = harness();
  state.setSession();
  assert.ok(state.find(element => element.type === "article"));
  globalThis.fetch = async () => Response.json({ error: { message: "Sign in" } }, { status: 401 });
  state.find(element => element.type === "textarea").props.onChange({ target: { value: "Where is my order?" } });
  state.find(element => element.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
  assert.equal(state.find(element => element.type === "article"), undefined);
  assert.equal(state.storage.has("cso.current-conversation-id"), false);
  assert.equal(state.find(element => element.type === "textarea").props.value, "");
});

test("handoff authentication failure clears the transcript and stored conversation", async () => {
  const state = harness();
  state.setSession();
  globalThis.fetch = async () => Response.json({ error: { message: "Sign in" } }, { status: 403 });
  state.find(element => element.type === "button" && element.props.children === "Talk to a person").props.onClick();
  await settle();
  assert.equal(state.find(element => element.type === "article"), undefined);
  assert.equal(state.storage.has("cso.current-conversation-id"), false);
});

test("pagehide removes visible transcript, and bfcache return reloads it from the server", async () => {
  const state = harness();
  state.setSession();
  assert.ok(state.find(element => element.type === "article"));
  state.listeners.get("pagehide")();
  assert.equal(state.find(element => element.type === "article"), undefined);
  assert.equal(state.storage.get("cso.current-conversation-id"), state.conversationId);
  let reads = 0;
  globalThis.fetch = async () => { reads += 1; return Response.json({
    conversation_id: state.conversationId, status: "OPEN", control_mode: "AI", control_version: 1,
    messages: [{ message_id: "message-2", sender_kind: "ASSISTANT", content: { type: "text", text: "Current server message" } }],
  }); };
  state.listeners.get("pageshow")({ persisted: true });
  await settle();
  assert.equal(reads, 1);
  assert.ok(state.find(element => element.type === "article"));
});

test("a late message response cannot restore the transcript after a separate account read returns 401", async () => {
  const state = harness();
  state.setSession();
  const messageRequest = deferred();
  globalThis.fetch = (url) => {
    if (url === "/api/account/recent-order-references") return Promise.resolve(new Response(null, { status: 401 }));
    if (url.includes("/messages")) return messageRequest.promise;
    throw new Error(`Unexpected request: ${url}`);
  };
  state.find(element => element.type === "textarea").props.onChange({ target: { value: "Where is my order?" } });
  state.find(element => element.type === "form").props.onSubmit({ preventDefault() {} });
  state.find(element => element.type?.name === "RecentOrderReferencesCard").props.onFind();
  await settle();
  assert.equal(state.find(element => element.type === "article"), undefined);
  messageRequest.resolve(Response.json({ conversation_id: state.conversationId,
    customer_message_id: "message-2", assistant_message: {
      message_id: "message-3", content: { type: "text", text: "Old private answer" },
    },
  }, { status: 202 }));
  await settle();
  assert.equal(state.find(element => element.type === "article"), undefined);
  assert.equal(state.storage.has("cso.current-conversation-id"), false);
});

test("a stale handoff version refreshes the authoritative conversation and releases the button", async () => {
  const state = harness();
  state.setSession();
  globalThis.fetch = async (url) => url.endsWith("/handoff")
    ? Response.json({ error: { message: "The conversation changed." } }, { status: 409 })
    : Response.json({ conversation_id: state.conversationId, status: "OPEN", control_mode: "AI",
      control_version: 2, messages: [] });
  state.find(element => element.type === "button" && element.props.children === "Talk to a person").props.onClick();
  await settle();
  const button = state.find(element => element.type === "button" && element.props.children === "Talk to a person");
  assert.ok(button);
  assert.equal(button.props.disabled, false);
  assert.equal(state.storage.get("cso.current-conversation-id"), state.conversationId);
});

const consultationLabel = "Talk to a person about a return or exchange";
const consultationButton = state => state.find(element => element.type === "button" && element.props.children === consultationLabel);
const queued = conversationId => ({ conversation_id: conversationId, status: "OPEN", control_mode: "QUEUED",
  control_version: 2, handoff_session_id: "22222222-2222-4222-8222-222222222222" });

test("return consultation starts only an explicit handoff, with no synthetic message or refund", async () => {
  const state = harness();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === "/api/conversations") return Response.json({ conversation_id: state.conversationId,
      status: "OPEN", control_mode: "AI", control_version: 1, messages: [] });
    assert.equal(url, `/api/conversations/${state.conversationId}/handoff`);
    return Response.json(queued(state.conversationId));
  };
  const button = consultationButton(state);
  assert.ok(button, "the customer must be able to explicitly choose a return consultation");
  assert.equal(button.props.disabled, false);
  assert.equal(calls.length, 0);
  button.props.onClick();
  await settle();
  assert.deepEqual(calls.map(call => call.url), ["/api/conversations", `/api/conversations/${state.conversationId}/handoff`]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { expected_control_version: 1 });
  assert.equal(state.find(element => element.type === "article"), undefined);
  assert.equal(consultationButton(state), undefined);
  assert.ok(state.find(element => element.type === "strong" && element.props.children === "Waiting for a specialist"));
});

test("saved-address consultation reuses handoff without sending address data or an account mutation", async () => {
  const state = harness();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === "/api/conversations") return Response.json({ conversation_id: state.conversationId,
      status: "OPEN", control_mode: "AI", control_version: 1, messages: [] });
    assert.equal(url, `/api/conversations/${state.conversationId}/handoff`);
    return Response.json(queued(state.conversationId));
  };
  const card = state.find(element => element.type?.name === "SavedAddressStatusCard");
  assert.ok(card);
  card.props.onConsult();
  await settle();
  assert.deepEqual(calls.map(call => call.url), ["/api/conversations", `/api/conversations/${state.conversationId}/handoff`]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { expected_control_version: 1 });
  assert.equal(state.find(element => element.type === "article"), undefined);
  assert.equal(state.find(element => element.type?.name === "SavedAddressStatusCard").props.consultationActive, true);
});

test("unavailable consultation cannot send a handoff or claim a request was received", () => {
  const state = harness(false);
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("No requests expected"); };
  const button = consultationButton(state);
  assert.ok(button);
  assert.equal(button.props.disabled, true);
  button.props.onClick();
  assert.equal(calls, 0);
  assert.ok(state.find(element => element.type === "p" && /Return and exchange consultation is currently unavailable/.test(element.props.children)));
  assert.equal(state.find(element => element.type === "strong" && element.props.children === "Waiting for a specialist"), undefined);
});

test("failed consultation reuses the same handoff key and shows queued only after server confirmation", async () => {
  const state = harness();
  state.setSession();
  const keys = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `/api/conversations/${state.conversationId}/handoff`);
    keys.push(init.headers["idempotency-key"]);
    return keys.length === 1 ? new Response(null, { status: 503 }) : Response.json(queued(state.conversationId));
  };
  consultationButton(state).props.onClick();
  await settle();
  assert.ok(state.find(element => element.props?.role === "alert"));
  assert.equal(state.find(element => element.type === "strong" && element.props.children === "Waiting for a specialist"), undefined);
  consultationButton(state).props.onClick();
  await settle();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.ok(state.find(element => element.type === "strong" && element.props.children === "Waiting for a specialist"));
});

test("consultation conflict refreshes authoritative queued state instead of creating a second handoff", async () => {
  const state = harness();
  state.setSession();
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    return url.endsWith("/handoff") ? new Response(null, { status: 409 })
      : Response.json({ ...queued(state.conversationId), messages: [] });
  };
  consultationButton(state).props.onClick();
  await settle();
  assert.deepEqual(calls, [`/api/conversations/${state.conversationId}/handoff`, `/api/conversations/${state.conversationId}`]);
  assert.equal(consultationButton(state), undefined);
  assert.equal(state.find(element => element.type === "article"), undefined);
});

test("queued consultation messages stay in the same chat and human replies are labeled", async () => {
  const state = harness();
  state.setSession();
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `/api/conversations/${state.conversationId}/handoff`);
    return Response.json(queued(state.conversationId));
  };
  consultationButton(state).props.onClick();
  await settle();
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `/api/conversations/${state.conversationId}/messages`);
    assert.equal(JSON.parse(init.body).content.text, "Can I exchange this item?");
    return Response.json({ conversation_id: state.conversationId, customer_message_id: "question-1",
      control_mode: "QUEUED", control_version: 2 });
  };
  state.find(element => element.type === "textarea").props.onChange({ target: { value: "Can I exchange this item?" } });
  state.find(element => element.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
  assert.ok(state.find(element => element.type === "p" && element.props.children === "Can I exchange this item?"));
  state.listeners.get("pagehide")();
  globalThis.fetch = async url => {
    assert.equal(url, `/api/conversations/${state.conversationId}`);
    return Response.json({ ...queued(state.conversationId), control_mode: "HUMAN", control_version: 3,
      messages: [{ message_id: "human-1", sender_kind: "WORKFORCE", content: { type: "text", text: "Let’s review your options." } }] });
  };
  state.listeners.get("pageshow")({ persisted: true });
  await settle();
  assert.equal(consultationButton(state), undefined);
  assert.ok(state.find(element => element.type === "article" && element.props["aria-label"] === "Support specialist message"));
});

test("consultation authentication loss clears private transcript and cannot restore it with a late response", async () => {
  const state = harness();
  state.setSession();
  const handoffRequest = deferred();
  globalThis.fetch = async url => url.endsWith("/handoff") ? handoffRequest.promise : new Response(null, { status: 401 });
  consultationButton(state).props.onClick();
  state.find(element => element.type?.name === "RecentOrderReferencesCard").props.onFind();
  await settle();
  assert.equal(state.find(element => element.type === "article"), undefined);
  assert.equal(state.storage.has("cso.current-conversation-id"), false);
  handoffRequest.resolve(Response.json(queued(state.conversationId)));
  await settle();
  assert.equal(state.find(element => element.type === "strong" && element.props.children === "Waiting for a specialist"), undefined);
  assert.equal(state.storage.has("cso.current-conversation-id"), false);
});

test("closed conversations offer no new consultation action", () => {
  const state = harness();
  state.setSession();
  state.slots[1] = { conversationId: state.conversationId, status: "CLOSED", controlMode: "AI", controlVersion: 4 };
  assert.equal(consultationButton(state), undefined);
});
