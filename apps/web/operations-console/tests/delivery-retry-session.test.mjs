import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const prefix = "cso.delivery-report.transition:";
const attempt = JSON.stringify({ reportId: "report-1", action: "claim", expectedVersion: 1, idempotencyKey: "old-staff-key" });
const report = { report_id: "report-1", status: "RECEIVED", category: "DAMAGED", order_reference: "ORDER1234", version: 1,
  created_at: "2026-10-02T12:00:00Z", updated_at: "2026-10-02T12:00:00Z" };
const acknowledged = { ...report, status: "ACKNOWLEDGED", version: 3, assigned_staff_id: "staff-a",
  claimed_at: report.created_at, acknowledged_at: report.created_at };
const closed = { ...acknowledged, status: "REVIEW_CLOSED", version: 4, closed_at: report.updated_at };

function harness(fetchResponse) {
  const values = new Map([[`${prefix}report-1`, attempt], [`${prefix}report-2`, attempt], ["cso.support-chat.attempt:chat-1", "keep"]]);
  const listeners = new Map();
  const navigations = [];
  const browser = {
    sessionStorage: { get length() { return values.size; }, key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    location: { assign: (path) => navigations.push({ path, keys: [...values.keys()] }), reload() {} },
    addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: (name) => listeners.delete(name),
  };
  let cursor = 0;
  let mounted = false;
  const slots = [];
  const effects = [];
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useCallback: (callback) => callback,
    useEffect(effect) { if (!mounted) effects.push(effect); },
  };
  function load(url) {
    const output = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    const module = { exports: {} };
    new Function("require", "module", "exports", "window", "fetch", "crypto", output)((id) => {
      if (id === "react") return hooks;
      if (id === "next/link" || id.endsWith(".css")) return { default: {} };
      if (id.startsWith(".")) return load(new URL(`${id}.ts`, url));
      return require(id);
    }, module, module.exports, browser, fetchResponse, { randomUUID: () => "new-staff-key" });
    return module.exports;
  }
  function render(component, props) { cursor = 0; const result = component(props); mounted = true; return result; }
  return { values, browser, navigations, listeners, effects, load, render };
}

function findButton(node, label) {
  if (!node || typeof node !== "object") return undefined;
  if (node.type === "button" && node.props.children === label) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = findButton(child, label);
    if (found) return found;
  }
}
function visibleText(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return [node.props?.children].flat(Infinity).map(visibleText).join(" ");
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("successful delivery sign-in removes prior staff retry keys before navigation, without touching chat storage", async () => {
  const h = harness(async (url, options) => {
    assert.equal(url, "/api/delivery-local-session"); assert.equal(options.method, "POST");
    return new Response("{}", { status: 200 });
  });
  const Page = h.load(new URL("../app/delivery-sign-in/page.tsx", import.meta.url)).default;
  await findButton(h.render(Page), "Continue as delivery staff").props.onClick();
  assert.deepEqual(h.navigations, [{ path: "/delivery-issue-reports", keys: ["cso.support-chat.attempt:chat-1"] }]);
});

test("failed delivery sign-in retains the uncertain retry identity", async () => {
  const h = harness(async () => new Response("{}", { status: 503 }));
  const Page = h.load(new URL("../app/delivery-sign-in/page.tsx", import.meta.url)).default;
  await findButton(h.render(Page), "Continue as delivery staff").props.onClick();
  assert.equal(h.values.get(`${prefix}report-1`), attempt);
  assert.deepEqual(h.navigations, []);
});

test("delivery sign-in cannot navigate with old retries when browser storage cannot be cleared", async () => {
  const h = harness(async () => new Response("{}", { status: 200 }));
  h.browser.sessionStorage.removeItem = () => { throw new Error("storage denied"); };
  const Page = h.load(new URL("../app/delivery-sign-in/page.tsx", import.meta.url)).default;
  await findButton(h.render(Page), "Continue as delivery staff").props.onClick();
  assert.deepEqual(h.navigations, []);
  assert.equal(h.values.get(`${prefix}report-1`), attempt);
});

test("an uncertain delivery transition still sends and retains its original staff retry key", async () => {
  const h = harness(async (_url, options) => {
    if (options.method === "POST") {
      assert.equal(options.headers["idempotency-key"], "old-staff-key");
      assert.deepEqual(JSON.parse(options.body), { expected_version: 1 });
      return new Response("{}", { status: 503 });
    }
    return Response.json({ delivery_issue_report: report, audit_events: [] });
  });
  const Detail = h.load(new URL("../components/delivery-report-detail.tsx", import.meta.url)).DeliveryReportDetail;
  h.render(Detail, { reportId: "report-1" });
  h.effects.forEach((effect) => effect()); await flush();
  findButton(h.render(Detail, { reportId: "report-1" }), "Claim report").props.onClick(); await flush();
  assert.equal(h.values.get(`${prefix}report-1`), attempt);
});

test("Close review appears only with verified assignee capability after acknowledgment", async () => {
  let wire = acknowledged;
  let capability = true;
  const h = harness(async () => Response.json({ delivery_issue_report: wire, audit_events: [], can_close_review: capability }));
  const Detail = h.load(new URL("../components/delivery-report-detail.tsx", import.meta.url)).DeliveryReportDetail;
  h.render(Detail, { reportId: "report-1" }); h.effects.forEach((effect) => effect()); await flush();
  assert.ok(findButton(h.render(Detail, { reportId: "report-1" }), "Close review"));
  capability = false;
  findButton(h.render(Detail, { reportId: "report-1" }), "Refresh status").props.onClick(); await flush();
  assert.equal(findButton(h.render(Detail, { reportId: "report-1" }), "Close review"), undefined);
  wire = { ...acknowledged, status: "CLAIMED", version: 2 };
  capability = true;
  findButton(h.render(Detail, { reportId: "report-1" }), "Refresh status").props.onClick(); await flush();
  assert.equal(findButton(h.render(Detail, { reportId: "report-1" }), "Close review"), undefined);
});

test("uncertain close re-reads authority and clears its key when review already closed", async () => {
  let reads = 0;
  const posts = [];
  const h = harness(async (url, options = {}) => {
    if (options.method === "POST") {
      posts.push({ url, body: JSON.parse(options.body), key: options.headers["idempotency-key"] });
      return new Response("{}", { status: 503 });
    }
    reads += 1;
    return Response.json({ delivery_issue_report: reads === 1 ? acknowledged : closed, can_close_review: reads === 1,
      audit_events: reads === 1 ? [] : [{ event_id: "close-event", event_type: "REPORT_REVIEW_CLOSED", actor_type: "HUMAN",
        actor_id: "staff-a", occurred_at: report.updated_at, report_version: 4 }] });
  });
  const Detail = h.load(new URL("../components/delivery-report-detail.tsx", import.meta.url)).DeliveryReportDetail;
  h.render(Detail, { reportId: "report-1" }); h.effects.forEach((effect) => effect()); await flush();
  findButton(h.render(Detail, { reportId: "report-1" }), "Close review").props.onClick(); await flush();
  assert.deepEqual(posts, [{ url: "/api/delivery-issue-reports/report-1/close", body: { expected_version: 3 }, key: "new-staff-key" }]);
  assert.equal(h.values.has(`${prefix}report-1`), false);
  const page = h.render(Detail, { reportId: "report-1" });
  assert.equal(findButton(page, "Close review"), undefined);
  assert.match(visibleText(page), /Review closed/);
  assert.match(visibleText(page), /REPORT REVIEW CLOSED/);
  assert.equal(reads, 2);
});

test("uncertain close keeps exact retry key when authoritative state has not advanced", async () => {
  const posts = [];
  const h = harness(async (_url, options = {}) => {
    if (options.method === "POST") {
      posts.push({ body: JSON.parse(options.body), key: options.headers["idempotency-key"] });
      return new Response("{}", { status: 503 });
    }
    return Response.json({ delivery_issue_report: acknowledged, audit_events: [], can_close_review: true });
  });
  const Detail = h.load(new URL("../components/delivery-report-detail.tsx", import.meta.url)).DeliveryReportDetail;
  h.render(Detail, { reportId: "report-1" }); h.effects.forEach((effect) => effect()); await flush();
  findButton(h.render(Detail, { reportId: "report-1" }), "Close review").props.onClick(); await flush();
  assert.equal(JSON.parse(h.values.get(`${prefix}report-1`)).idempotencyKey, "new-staff-key");
  findButton(h.render(Detail, { reportId: "report-1" }), "Close review").props.onClick(); await flush();
  assert.deepEqual(posts, [{ body: { expected_version: 3 }, key: "new-staff-key" }, { body: { expected_version: 3 }, key: "new-staff-key" }]);
});

test("stale close response refreshes terminal state and cannot offer another close", async () => {
  let reads = 0;
  const h = harness(async (_url, options = {}) => {
    if (options.method === "POST") return new Response("{}", { status: 409 });
    reads += 1;
    return Response.json({ delivery_issue_report: reads === 1 ? acknowledged : closed, audit_events: [], can_close_review: reads === 1 });
  });
  const Detail = h.load(new URL("../components/delivery-report-detail.tsx", import.meta.url)).DeliveryReportDetail;
  h.render(Detail, { reportId: "report-1" }); h.effects.forEach((effect) => effect()); await flush();
  findButton(h.render(Detail, { reportId: "report-1" }), "Close review").props.onClick(); await flush();
  assert.equal(reads, 2);
  assert.equal(h.values.has(`${prefix}report-1`), false);
  assert.equal(findButton(h.render(Detail, { reportId: "report-1" }), "Close review"), undefined);
});

for (const status of [401, 403]) {
  test(`close ${status} clears staff retry identities and hides private detail`, async () => {
    const h = harness(async (_url, options = {}) => options.method === "POST" ? new Response("{}", { status }) :
      Response.json({ delivery_issue_report: acknowledged, audit_events: [], can_close_review: true }));
    const Detail = h.load(new URL("../components/delivery-report-detail.tsx", import.meta.url)).DeliveryReportDetail;
    h.render(Detail, { reportId: "report-1" }); h.effects.forEach((effect) => effect()); await flush();
    findButton(h.render(Detail, { reportId: "report-1" }), "Close review").props.onClick(); await flush();
    assert.deepEqual([...h.values.entries()], [["cso.support-chat.attempt:chat-1", "keep"]]);
    assert.equal(findButton(h.render(Detail, { reportId: "report-1" }), "Close review"), undefined);
  });
}

for (const action of ["claim", "acknowledge"]) {
  test(`old uncertain ${action} is cleared after authoritative review close`, async () => {
    const h = harness(async () => Response.json({ delivery_issue_report: closed, audit_events: [], can_close_review: false }));
    h.values.set(`${prefix}report-1`, JSON.stringify({ reportId: "report-1", action,
      expectedVersion: action === "claim" ? 1 : 2, idempotencyKey: "old-staff-key" }));
    const Detail = h.load(new URL("../components/delivery-report-detail.tsx", import.meta.url)).DeliveryReportDetail;
    h.render(Detail, { reportId: "report-1" }); h.effects.forEach((effect) => effect()); await flush();
    assert.equal(h.values.has(`${prefix}report-1`), false);
  });
}

for (const status of [401, 403]) {
  test(`delivery queue ${status} clears every old delivery attempt`, async () => {
    const h = harness(async () => new Response("{}", { status }));
    const Queue = h.load(new URL("../components/delivery-report-queue.tsx", import.meta.url)).DeliveryReportQueue;
    h.render(Queue);
    h.effects.forEach((effect) => effect()); await flush();
    assert.deepEqual([...h.values.entries()], [["cso.support-chat.attempt:chat-1", "keep"]]);
  });
  test(`delivery detail ${status} read clears every old delivery attempt`, async () => {
    const h = harness(async () => new Response("{}", { status }));
    const Detail = h.load(new URL("../components/delivery-report-detail.tsx", import.meta.url)).DeliveryReportDetail;
    h.render(Detail, { reportId: "report-1" });
    h.effects.forEach((effect) => effect()); await flush();
    assert.deepEqual([...h.values.entries()], [["cso.support-chat.attempt:chat-1", "keep"]]);
  });
  test(`delivery detail ${status} transition clears every old delivery attempt`, async () => {
    const h = harness(async (_url, options) => options.method === "POST" ? new Response("{}", { status }) :
      Response.json({ delivery_issue_report: report, audit_events: [] }));
    const Detail = h.load(new URL("../components/delivery-report-detail.tsx", import.meta.url)).DeliveryReportDetail;
    h.render(Detail, { reportId: "report-1" });
    h.effects.forEach((effect) => effect()); await flush();
    findButton(h.render(Detail, { reportId: "report-1" }), "Claim report").props.onClick(); await flush();
    assert.deepEqual([...h.values.entries()], [["cso.support-chat.attempt:chat-1", "keep"]]);
  });
}

test("ordinary delivery page exit preserves the same uncertain retry key", async () => {
  const h = harness(async () => Response.json({ delivery_issue_report: report, audit_events: [] }));
  const Detail = h.load(new URL("../components/delivery-report-detail.tsx", import.meta.url)).DeliveryReportDetail;
  h.render(Detail, { reportId: "report-1" });
  h.effects.forEach((effect) => effect()); await flush();
  h.listeners.get("pagehide")();
  assert.equal(h.values.get(`${prefix}report-1`), attempt);
});
