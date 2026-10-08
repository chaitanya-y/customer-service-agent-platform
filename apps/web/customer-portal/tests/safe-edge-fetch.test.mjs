import assert from "node:assert/strict";
import { test } from "node:test";

import { safeEdgeFetch } from "../lib/safe-edge-fetch.ts";

test("customer bearer token is never forwarded through an upstream redirect", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 307, headers: { location: "https://other.example/collect" } });
  };

  await assert.rejects(
    safeEdgeFetch(new URL("http://127.0.0.1:3000/v1/refunds"), {
      headers: { authorization: "Bearer local-secret" },
    }, fetcher),
    /redirect/i,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.authorization, "Bearer local-secret");
});

test("customer Edge proxy accepts a normal response", async () => {
  const response = new Response("{}", { status: 200 });
  const actual = await safeEdgeFetch(new URL("http://127.0.0.1:3000/v1/refunds"), {}, async (_url, init) => {
    assert.equal(init.redirect, "manual");
    return response;
  });
  assert.equal(actual, response);
});
