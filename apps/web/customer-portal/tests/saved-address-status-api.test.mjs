import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const status = {
  schemaVersion: "1", savedAddressCount: 2,
  hasDefaultShippingAddress: true, hasDefaultBillingAddress: false,
};
const api = () => import("../components/saved-address-status-api.ts");

test("accepts only the four safe saved-address status fields", async () => {
  const { parseSavedAddressStatus } = await api();
  assert.deepEqual(parseSavedAddressStatus(status), status);
  for (const value of [
    null, [], {}, { ...status, schemaVersion: "2" },
    { ...status, savedAddressCount: -1 }, { ...status, savedAddressCount: 1.5 },
    { ...status, savedAddressCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...status, savedAddressCount: 1001 },
    { ...status, hasDefaultShippingAddress: "true" },
    { ...status, address: "private address" },
    { ...status, savedAddressCount: 0 },
  ]) assert.throws(() => parseSavedAddressStatus(value), /not valid/i);
  assert.deepEqual(parseSavedAddressStatus({ ...status, savedAddressCount: 0,
    hasDefaultShippingAddress: false }), { ...status, savedAddressCount: 0,
    hasDefaultShippingAddress: false });
});

test("loads saved-address status without a conversation, credentials, or mutation", async () => {
  const { loadSavedAddressStatus } = await api();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json(status);
  };
  assert.deepEqual(await loadSavedAddressStatus(), status);
  assert.deepEqual(calls, [{ url: "/api/account/saved-address-status",
    init: { method: "GET", cache: "no-store" } }]);
});

test("does not turn failed, malformed, or uncertain reads into saved-address success", async () => {
  const { loadSavedAddressStatus, SavedAddressStatusApiError } = await api();
  for (const [code, body] of [[401, { error: { message: "secret internal details" } }],
    [503, {}], [202, status], [200, { ...status, streetLine1: "private" }]]) {
    globalThis.fetch = async () => Response.json(body, { status: code });
    await assert.rejects(loadSavedAddressStatus(), (error) => {
      assert.ok(error instanceof SavedAddressStatusApiError);
      assert.equal(error.status, code);
      assert.doesNotMatch(error.message, /secret internal|private/);
      return true;
    });
  }
  globalThis.fetch = async () => new Response("not json", { status: 200 });
  await assert.rejects(loadSavedAddressStatus(), /could not check/i);
});
