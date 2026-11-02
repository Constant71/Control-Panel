import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/server/diagnostics.ts";

test("the debug export never carries the API key, password or anything shaped like a token", () => {
  const out = JSON.stringify(redact({
    gameBaseUrl: "https://neumann-probe.net",
    apiKey: "abc", nested: [{ token: "t1", password: "p", note: "key is vng_SECRET123 here" }],
    header: "Bearer eyJhbGciOi.xyz", text: "my-own-key-value appears", ok: { name: "Prime", amount: 3, key: null },
  }, ["my-own-key-value", ""]));
  for (const s of ["abc", "t1", "\"p\"", "vng_SECRET123", "eyJhbGciOi", "my-own-key-value"]) assert.ok(!out.includes(s), s);
  assert.ok(out.includes("Prime") && out.includes("neumann-probe.net") && out.includes("\"amount\":3"));
});
