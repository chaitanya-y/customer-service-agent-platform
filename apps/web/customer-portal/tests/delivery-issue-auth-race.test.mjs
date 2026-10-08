import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
});

function load(path, dependencies) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(dependencies, module, module.exports);
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

function harness(createConversation) {
  const values = new Map();
  const listeners = new Map();
  const effects = [];
  let mounted = false;
  let cursor = 0;
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
    useEffect(effect) { if (!mounted) effects.push(effect); },
  };
  const slots = [];
  globalThis.window = {
    sessionStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: key => { values.delete(key); },
    },
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: (type, listener) => { listeners.set(type, listener); },
    removeEventListener: (type) => { listeners.delete(type); },
  };
  const api = load("../components/delivery-issue-api.ts", require);
  const refresh = load("../components/delivery-issue-refresh.ts", name => name === "./delivery-issue-api" ? api : require(name));
  const history = load("../components/delivery-issue-history-controller.ts", require);
  const session = load("../components/customer-session-state.ts", require);
  const { DeliveryIssueForm } = load("../components/delivery-issue-form.tsx", name => {
    if (name === "react") return hooks;
    if (name === "./delivery-issue-api") return api;
    if (name === "./delivery-issue-refresh") return refresh;
    if (name === "./delivery-issue-history-controller") return history;
    if (name === "./customer-session-state") return session;
    if (name === "./delivery-issue-history") return { DeliveryIssueHistoryPanel: function DeliveryIssueHistoryPanel() {} };
    if (name === "./conversation-api") return { createCustomerConversation: createConversation, loadCustomerConversation: async () => ({ status: "OPEN" }) };
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
    return visit(DeliveryIssueForm());
  };
  find(() => false);
  mounted = true;
  for (const effect of effects) effect();
  const fill = () => {
    find(element => element.type === "input" && element.props.id === "delivery-order-reference")
      .props.onChange({ target: { value: "ORDER1234" } });
    find(element => element.type === "select" && element.props.id === "delivery-issue-category")
      .props.onChange({ target: { value: "DAMAGED" } });
  };
  const submit = () => find(element => element.type === "form").props.onSubmit({ preventDefault() {} });
  const viewHistory = () => find(element => element.type?.name === "DeliveryIssueHistoryPanel").props.onView();
  return { values, slots, listeners, find, fill, submit, viewHistory };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const receipt = { delivery_issue_report: {
  report_id: "delivery-123", status: "RECEIVED", category: "DAMAGED", order_reference: "ORDER1234",
  created_at: "2026-10-02T12:00:00.000Z", updated_at: "2026-10-02T12:00:00.000Z",
} };

test("a history 401 prevents an older pending report response from republishing a receipt", async () => {
  const reportRequest = deferred();
  globalThis.fetch = (url) => {
    if (url === "/api/delivery-issue-reports") return Promise.resolve(new Response(null, { status: 401 }));
    if (url.includes("/delivery-issue-reports")) return reportRequest.promise;
    throw new Error(`Unexpected request: ${url}`);
  };
  const state = harness(async () => ({ conversationId: "11111111-1111-4111-8111-111111111111" }));
  state.fill();
  const submission = state.submit();
  await settle();
  state.viewHistory();
  await settle();
  assert.equal(state.values.size, 0);
  reportRequest.resolve(Response.json(receipt, { status: 201 }));
  await submission;
  assert.equal(state.values.size, 0);
  assert.equal(state.find(element => element.type === "aside"), undefined);
});

test("a history 401 prevents a delayed conversation creation from sending a report", async () => {
  const conversationRequest = deferred();
  let reportCalls = 0;
  globalThis.fetch = (url) => {
    if (url === "/api/delivery-issue-reports") return Promise.resolve(new Response(null, { status: 401 }));
    reportCalls += 1;
    throw new Error(`Unexpected request: ${url}`);
  };
  const state = harness(() => conversationRequest.promise);
  state.fill();
  const submission = state.submit();
  state.viewHistory();
  await settle();
  conversationRequest.resolve({ conversationId: "11111111-1111-4111-8111-111111111111" });
  await submission;
  assert.equal(reportCalls, 0);
  assert.equal(state.values.size, 0);
});

test("pagehide clears visible history and invalidates a late result but preserves the uncertain retry key", async () => {
  const reportRequest = deferred();
  globalThis.fetch = (url) => {
    if (url === "/api/delivery-issue-reports") return Promise.resolve(Response.json({
      delivery_issue_reports: [receipt.delivery_issue_report], has_more: false,
    }));
    if (url.includes("/delivery-issue-reports")) return reportRequest.promise;
    throw new Error(`Unexpected request: ${url}`);
  };
  const state = harness(async () => ({ conversationId: "11111111-1111-4111-8111-111111111111" }));
  state.fill();
  const submission = state.submit();
  await settle();
  state.viewHistory();
  await settle();
  assert.equal(state.find(element => element.type?.name === "DeliveryIssueHistoryPanel").props.state.reports.length, 1);
  const before = JSON.parse(state.values.get("cso.delivery-issue.pending-attempt"));
  state.listeners.get("pagehide")();
  assert.equal(state.find(element => element.type?.name === "DeliveryIssueHistoryPanel").props.state.reports, undefined);
  assert.equal(state.find(element => element.type === "aside"), undefined);
  assert.deepEqual(JSON.parse(state.values.get("cso.delivery-issue.pending-attempt")), before);
  reportRequest.resolve(Response.json(receipt, { status: 201 }));
  await submission;
  assert.equal(state.values.has("cso.delivery-issue.report-id"), false);
  assert.deepEqual(JSON.parse(state.values.get("cso.delivery-issue.pending-attempt")), before);
  state.listeners.get("pageshow")({ persisted: true });
  assert.equal(state.find(element => element.type === "input" && element.props.id === "delivery-order-reference").props.value, "ORDER1234");
});
