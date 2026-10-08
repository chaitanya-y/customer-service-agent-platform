import assert from "node:assert/strict";
import { test } from "node:test";

import { safeStaffFetch } from "../lib/safe-staff-fetch.ts";

test("delivery staff assertions are never forwarded through upstream redirects", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: 302, headers: { location: "https://other.example/collect" } });
  };

  await assert.rejects(
    safeStaffFetch(new URL("http://127.0.0.1:3003/v1/delivery-issue-reports"), {
      method: "GET",
      headers: { "x-cso-delivery-staff-assertion": "staff-secret" },
    }, fetcher),
    /redirect/i,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.headers["x-cso-delivery-staff-assertion"], "staff-secret");
});

test("normal delivery staff upstream responses are returned unchanged", async () => {
  const response = new Response("{}", { status: 200 });
  const actual = await safeStaffFetch(new URL("http://127.0.0.1:3003/v1/delivery-issue-reports"), {
    method: "GET",
  }, async (_url, options) => {
    assert.equal(options.redirect, "manual");
    return response;
  });
  assert.equal(actual, response);
});
