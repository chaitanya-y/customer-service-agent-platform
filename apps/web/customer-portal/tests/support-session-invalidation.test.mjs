import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const conversationId = "11111111-1111-4111-8111-111111111111";
const conversation = { conversation_id: conversationId, status: "OPEN", control_mode: "AI", control_version: 1,
  messages: [{ message_id: "private-1", sender_kind: "ASSISTANT", content: { type: "text", text: "Private customer answer" } }] };
const receipt = { report_id: "delivery-123", status: "RECEIVED", category: "DAMAGED", order_reference: "ORDER1234",
  created_at: "2026-10-02T12:00:00.000Z", updated_at: "2026-10-02T12:00:00.000Z" };

function harness() {
  const storage = new Map([["cso.current-conversation-id", conversationId]]);
  const listeners = new Map();
  globalThis.window = {
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    setInterval: () => 1, clearInterval() {}, location: { assign() { throw new Error("Stale navigation"); } },
  };
  let active;
  const hooks = { ...require("react"),
    useState(initial) {
      const state = active; const index = state.cursor++;
      if (!(index in state.slots)) state.slots[index] = initial;
      return [state.slots[index], value => { state.slots[index] = typeof value === "function" ? value(state.slots[index]) : value; }];
    },
    useRef(initial) {
      const index = active.cursor++;
      if (!(index in active.slots)) active.slots[index] = { current: initial };
      return active.slots[index];
    },
    useCallback: callback => callback,
    useEffect(effect) { if (!active.mounted) active.effects.push(effect); },
  };
  const modules = new Map();
  function load(name) {
    if (name === "react") return hooks;
    if (name.endsWith(".css")) return { default: {} };
    if (!name.startsWith("./") && name !== "@cso/ui/refund-evidence-model") return require(name);
    if (modules.has(name)) return modules.get(name);
    let source;
    try { source = readFileSync(name === "@cso/ui/refund-evidence-model" ? require.resolve(name) : new URL(`../components/${name.slice(2)}.ts`, import.meta.url), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; source = readFileSync(new URL(`../components/${name.slice(2)}.tsx`, import.meta.url), "utf8"); }
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    new Function("require", "module", "exports", output)(load, module, module.exports);
    modules.set(name, module.exports);
    return module.exports;
  }
  function mount(Component, props = {}) {
    const state = { slots: [], effects: [], cursor: 0, mounted: false };
    const render = () => { active = state; state.cursor = 0; return Component(props); };
    const find = predicate => {
      function visit(element) {
        if (!element || typeof element !== "object") return;
        if (predicate(element)) return element;
        for (const child of [element.props?.children].flat(Infinity)) { const found = visit(child); if (found) return found; }
      }
      return visit(render());
    };
    render(); state.mounted = true; for (const effect of state.effects) effect();
    return { find };
  }
  const chat = mount(load("./support-chat").SupportChat, { handoffAvailable: true });
  const delivery = mount(load("./delivery-issue-form").DeliveryIssueForm);
  return { storage, chat, delivery, session: () => load("./customer-session-state"),
    pagehide: () => { for (const listener of listeners.get("pagehide") ?? []) listener(); } };
}
const history = state => state.delivery.find(element => element.type?.name === "DeliveryIssueHistoryPanel");
const chatArticle = state => state.chat.find(element => element.type === "article");
function submitDelivery(state) {
  state.delivery.find(element => element.type === "input").props.onChange({ target: { value: "ORDER1234" } });
  state.delivery.find(element => element.type === "select").props.onChange({ target: { value: "DAMAGED" } });
  return state.delivery.find(element => element.type === "form").props.onSubmit({ preventDefault() {} });
}
function sendChat(state) {
  state.chat.find(element => element.type === "textarea").props.onChange({ target: { value: "Where is my order?" } });
  return state.chat.find(element => element.type === "form").props.onSubmit({ preventDefault() {} });
}

for (const status of [401, 403]) {
  test(`delivery history ${status} clears sibling chat and blocks its late message`, async () => {
    const message = deferred();
    globalThis.fetch = async url => url === `/api/conversations/${conversationId}` ? Response.json(conversation)
      : url.endsWith("/messages") ? message.promise : new Response(null, { status });
    const state = harness(); await settle();
    assert.ok(chatArticle(state));
    const pending = sendChat(state);
    history(state).props.onView(); await settle();
    assert.equal(chatArticle(state), undefined);
    assert.equal(state.storage.has("cso.current-conversation-id"), false);
    message.resolve(Response.json({ conversation_id: conversationId, customer_message_id: "private-2",
      assistant_message: { message_id: "private-3", content: { type: "text", text: "Late private answer" } } }, { status: 202 }));
    await pending;
    assert.equal(chatArticle(state), undefined);
  });

  test(`chat ${status} clears delivery receipt, history, draft and late submission`, async () => {
    const report = deferred();
    globalThis.fetch = async url => {
      if (url === `/api/conversations/${conversationId}`) return Response.json(conversation);
      if (url === "/api/conversations") return Response.json(conversation, { status: 201 });
      if (url === "/api/delivery-issue-reports") return Response.json({ delivery_issue_reports: [receipt], has_more: false });
      if (url === "/api/delivery-issue-reports/delivery-123") return Response.json({ delivery_issue_report: receipt });
      if (url.endsWith("/delivery-issue-reports")) return report.promise;
      return new Response(null, { status });
    };
    const state = harness(); await settle();
    history(state).props.onView(); await settle();
    history(state).props.onSelect(history(state).props.state.reports[0]); await settle();
    assert.ok(state.delivery.find(element => element.type === "aside"));
    const submission = submitDelivery(state); await settle();
    await sendChat(state);
    assert.equal(history(state).props.state.reports, undefined);
    assert.equal(state.delivery.find(element => element.type === "aside"), undefined);
    assert.equal(state.delivery.find(element => element.type === "input").props.value, "");
    assert.equal(state.storage.size, 0);
    report.resolve(Response.json({ delivery_issue_report: receipt }, { status: 201 })); await submission;
    assert.equal(state.storage.size, 0);
    assert.equal(state.delivery.find(element => element.type === "aside"), undefined);
  });
}

test("a chat auth failure blocks a late sibling history response", async () => {
  const historyRequest = deferred();
  globalThis.fetch = async url => url === `/api/conversations/${conversationId}` ? Response.json(conversation)
    : url === "/api/delivery-issue-reports" ? historyRequest.promise : new Response(null, { status: 401 });
  const state = harness(); await settle();
  history(state).props.onView();
  await sendChat(state);
  historyRequest.resolve(Response.json({ delivery_issue_reports: [receipt], has_more: false })); await settle();
  assert.equal(history(state).props.state.reports, undefined);
});

test("pagehide hides both components without broadcasting auth loss or deleting uncertain retry keys", async () => {
  const report = deferred();
  globalThis.fetch = async url => url === `/api/conversations/${conversationId}` || url === "/api/conversations"
    ? Response.json(conversation, { status: 201 }) : report.promise;
  const state = harness(); await settle();
  const submission = submitDelivery(state); await settle();
  const attempt = state.storage.get("cso.delivery-issue.pending-attempt");
  const epoch = state.session().customerSessionEpoch();
  state.pagehide();
  assert.equal(chatArticle(state), undefined);
  assert.equal(state.session().customerSessionEpoch(), epoch);
  assert.equal(state.storage.get("cso.delivery-issue.pending-attempt"), attempt);
  assert.equal(state.storage.get("cso.current-conversation-id"), conversationId);
  report.resolve(Response.json({ delivery_issue_report: receipt }, { status: 201 })); await submission;
  assert.equal(state.delivery.find(element => element.type === "aside"), undefined);
});

for (const status of [401, 403]) {
  test(`cancellation-start ${status} clears private chat and sibling delivery history`, async () => {
    globalThis.fetch = async url => {
      if (url === `/api/conversations/${conversationId}`) return Response.json(conversation);
      if (url === "/api/delivery-issue-reports") return Response.json({ delivery_issue_reports: [receipt], has_more: false });
      if (url.endsWith("/messages")) return Response.json({ conversation_id: conversationId, customer_message_id: "private-2",
        assistant_message: { message_id: "private-3", content: { type: "text", text: "Review this order" } },
        cancellation_request: { order_reference: "ORDER1234" } }, { status: 202 });
      assert.equal(url, "/api/cancellations");
      return new Response(null, { status });
    };
    const state = harness(); await settle();
    history(state).props.onView(); await settle();
    await sendChat(state);
    const review = state.chat.find(element => element.type?.name === "CancellationReviewAction");
    assert.ok(review);
    review.props.onReview(); await settle();
    assert.equal(chatArticle(state), undefined);
    assert.equal(history(state).props.state.reports, undefined);
    assert.equal(state.storage.size, 0);
  });
}

for (const card of ["SavedAddressStatusCard", "RecentOrderReferencesCard"]) {
  test(`delivery auth loss invalidates a late sibling ${card} read`, async () => {
    const read = deferred();
    globalThis.fetch = async url => url === `/api/conversations/${conversationId}` ? Response.json(conversation)
      : url.startsWith("/api/account/") ? read.promise : new Response(null, { status: 401 });
    const state = harness(); await settle();
    const account = state.chat.find(element => element.type?.name === card);
    (account.props.onCheck ?? account.props.onFind)();
    history(state).props.onView(); await settle();
    read.resolve(Response.json(card === "SavedAddressStatusCard"
      ? { schemaVersion: "1", savedAddressCount: 3, hasDefaultShippingAddress: true, hasDefaultBillingAddress: true }
      : { schemaVersion: "1", orders: [{ reference: "ORDER1234", placedAt: "2026-10-01T12:00:00.000Z" }], hasMore: false }));
    await settle();
    const props = state.chat.find(element => element.type?.name === card).props;
    assert.equal(props.status ?? props.result, undefined);
    assert.equal(props.loading, false);
  });
}

test("a stale cancellation-start success cannot navigate after sibling auth loss", async () => {
  const start = deferred();
  globalThis.fetch = async url => {
    if (url === `/api/conversations/${conversationId}`) return Response.json(conversation);
    if (url.endsWith("/messages")) return Response.json({ conversation_id: conversationId, customer_message_id: "private-2",
      assistant_message: { message_id: "private-3", content: { type: "text", text: "Review this order" } },
      cancellation_request: { order_reference: "ORDER1234" } }, { status: 202 });
    if (url === "/api/cancellations") return start.promise;
    return new Response(null, { status: 401 });
  };
  const state = harness(); await settle();
  await sendChat(state);
  state.chat.find(element => element.type?.name === "CancellationReviewAction").props.onReview();
  history(state).props.onView(); await settle();
  let navigation;
  globalThis.window.location.assign = value => { navigation = value; };
  start.resolve(Response.json({ workflow_id: `cancel-${"a".repeat(64)}` }, { status: 202 })); await settle();
  assert.equal(navigation, undefined);
  assert.equal(chatArticle(state), undefined);
});

test("one auth epoch broadcasts once, ignores echo and stale notices, and releases unsubscribed listeners", () => {
  const state = harness();
  const session = state.session();
  const initial = session.customerSessionEpoch();
  let calls = 0;
  const unsubscribe = session.subscribeCustomerAuthLost(() => { calls += 1; session.notifyCustomerAuthLost(); });
  session.notifyCustomerAuthLost(initial);
  session.notifyCustomerAuthLost(initial);
  assert.equal(calls, 1);
  assert.equal(session.customerSessionEpoch(), initial + 1);
  unsubscribe();
  session.notifyCustomerAuthLost();
  assert.equal(calls, 1);
});

for (const status of [401, 403]) {
  test(`delivery submission ${status} clears sibling chat and its own attempt`, async () => {
    globalThis.fetch = async url => url === `/api/conversations/${conversationId}` || url === "/api/conversations"
      ? Response.json(conversation, { status: 201 }) : new Response(null, { status });
    const state = harness(); await settle();
    assert.ok(chatArticle(state));
    await submitDelivery(state);
    assert.equal(chatArticle(state), undefined);
    assert.equal(state.storage.size, 0);
    assert.equal(state.delivery.find(element => element.type === "input").props.value, "");
  });

  test(`delivery receipt refresh ${status} clears sibling chat and visible receipt`, async () => {
    globalThis.fetch = async url => url === `/api/conversations/${conversationId}` ? Response.json(conversation)
      : url === "/api/delivery-issue-reports" ? Response.json({ delivery_issue_reports: [receipt], has_more: false })
      : new Response(null, { status });
    const state = harness(); await settle();
    history(state).props.onView(); await settle();
    history(state).props.onSelect(history(state).props.state.reports[0]); await settle();
    assert.equal(chatArticle(state), undefined);
    assert.equal(state.delivery.find(element => element.type === "aside"), undefined);
    assert.equal(history(state).props.state.reports, undefined);
    assert.equal(state.storage.size, 0);
  });
}
