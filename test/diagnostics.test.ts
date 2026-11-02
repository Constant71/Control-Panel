import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/server/diagnostics.ts";

test("the debug export never carries the API key, password or anything shaped like a token", () => {
  const out = JSON.stringify(redact({
    gameBaseUrl: "https://neumann-probe.net",
    apiKey: "abc", nested: [{ token: "t1", password: "p", note: "key is vng_SECRET123 here" }],
    header: "Bearer eyJhbGciOi.xyz", text: "my-own-key-value appears", ok: { name: "Prime", amount: 3 },
  }, ["my-own-key-value", ""]));
  for (const s of ["abc", "t1", "\"p\"", "vng_SECRET123", "eyJhbGciOi", "my-own-key-value"]) assert.ok(!out.includes(s), s);
  assert.ok(out.includes("Prime") && out.includes("neumann-probe.net") && out.includes("\"amount\":3"));
});

test("ordinary fields named key (problem keys) survive the export", () => {
  const out = redact({ problems: [{ key: "probe:1190:fuel" }] }) as { problems: Array<{ key: string }> };
  assert.equal(out.problems[0].key, "probe:1190:fuel");
});
