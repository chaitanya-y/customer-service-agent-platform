import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });

function load(path, dependencies) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => dependencies(name), module, module.exports);
  return module.exports;
}
function supportHarness() {
  const stored = new Map();
  globalThis.window = { addEventListener() {}, removeEventListener() {}, sessionStorage: {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
    removeItem: key => { stored.delete(key); },
  } };
  // Keep production action handlers and API parsing real; only React's lifecycle
  // is controlled, because these Node-only tests do not have a browser renderer.
  const slots = [];
  const effects = [];
  let mounted = false;
  let cursor = 0;
  const hooks = {
    ...require('react'),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: callback => callback,
    useEffect: effect => { if (!mounted) effects.push(effect); },
  };
  const api = load('../components/recent-order-references-api.ts', require);
  const customerApi = load('../components/customer-api.ts', require);
  const conversationApi = load('../components/conversation-api.ts', name => name === './customer-api' ? customerApi : require(name));
  const session = load('../components/customer-session-state.ts', require);
  const { SupportChat } = load('../components/support-chat.tsx', name => {
    if (name === 'react') return hooks;
    if (name === './recent-order-references-api') return api;
    if (name === './conversation-api') return conversationApi;
    if (name === './customer-session-state') return session;
    if (name.endsWith('.css')) return { default: {} };
    if (name.startsWith('./')) return {};
    return require(name);
  });
  function findCard(element) {
    if (!element || typeof element !== 'object') return;
    if (element.type?.name === 'RecentOrderReferencesCard') return element;
    for (const child of [element.props?.children].flat(Infinity)) {
      const found = findCard(child);
      if (found) return found;
    }
  }
  const render = () => {
    cursor = 0;
    const card = findCard(SupportChat({ handoffAvailable: false }));
    if (!mounted) { mounted = true; for (const effect of effects) effect(); }
    assert.ok(card, 'support page must mount the recent-orders action');
    return card.props;
  };
  render.find = predicate => {
    cursor = 0;
    const visit = element => {
      if (!element || typeof element !== 'object') return;
      if (predicate(element)) return element;
      for (const child of [element.props?.children].flat(Infinity)) {
        const found = visit(child);
        if (found) return found;
      }
    };
    return visit(SupportChat({ handoffAvailable: false }));
  };
  return render;
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const result = { schemaVersion: '1', orders: [{ reference: 'ORDER1234', placedAt: '2026-10-01T12:00:00.000Z' }], hasMore: false };

test('support action reads only when clicked, prevents duplicate reads and publishes reference data', async () => {
  let calls = 0;
  let complete;
  globalThis.fetch = (url, init) => {
    calls++;
    assert.equal(url, '/api/account/recent-order-references');
    assert.equal(init.method, 'GET');
    return new Promise(resolve => { complete = resolve; });
  };
  const render = supportHarness();
  const initial = render();
  assert.equal(calls, 0);
  assert.equal(initial.result, undefined);
  initial.onFind();
  initial.onFind();
  assert.equal(calls, 1);
  assert.equal(render().loading, true);
  complete(Response.json(result));
  await settle();
  const ready = render();
  assert.equal(ready.loading, false);
  assert.deepEqual(ready.result, result);
  assert.equal(ready.error, undefined);
});
test('support action clears stale references on failure and retries without starting a journey', async () => {
  const render = supportHarness();
  globalThis.fetch = async () => Response.json(result);
  render().onFind();
  await settle();
  assert.deepEqual(render().result, result);
  globalThis.fetch = async () => Response.json({ error: { message: 'private diagnostics' } }, { status: 503 });
  render().onFind();
  assert.equal(render().result, undefined);
  await settle();
  const failed = render();
  assert.match(failed.error, /try again/i);
  assert.doesNotMatch(failed.error, /private/);
  assert.equal(failed.loading, false);
  globalThis.fetch = async () => Response.json({ schemaVersion: '1', orders: [], hasMore: false });
  failed.onFind();
  await settle();
  const retried = render();
  assert.equal(retried.error, undefined);
  assert.deepEqual(retried.result.orders, []);
});

test('a conversation authentication failure clears previously displayed recent orders', async () => {
  const render = supportHarness();
  globalThis.fetch = async () => Response.json(result);
  render().onFind();
  await settle();
  assert.deepEqual(render().result, result);

  globalThis.fetch = async () => Response.json({ error: { code: 'customer_unauthorized' } }, { status: 401 });
  render.find(element => element.type === 'textarea').props.onChange({ target: { value: 'Where is my order?' } });
  render.find(element => element.type === 'form').props.onSubmit({ preventDefault() {} });
  await settle();
  assert.equal(render().result, undefined);
});

test('authentication loss prevents an in-flight recent-order read from publishing', async () => {
  const render = supportHarness();
  let finishRead;
  globalThis.fetch = async url => url === '/api/account/recent-order-references'
    ? new Promise(resolve => { finishRead = resolve; })
    : Response.json({ error: { code: 'customer_unauthorized' } }, { status: 401 });
  render().onFind();
  assert.equal(render().loading, true);
  render.find(element => element.type === 'textarea').props.onChange({ target: { value: 'Where is my order?' } });
  render.find(element => element.type === 'form').props.onSubmit({ preventDefault() {} });
  await settle();
  finishRead(Response.json(result));
  await settle();
  assert.equal(render().result, undefined);
  assert.equal(render().loading, false);
});
