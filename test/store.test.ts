import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonStore, storageHealth } from "../src/server/store.ts";

test("a save that can't be written is reported (shown as a banner), and clears once saving works", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "store-"));
  const blocked = path.join(dir, "not-a-folder");
  await writeFile(blocked, "x"); // a file where the data folder should be
  const bad = new JsonStore<{ a: number }>(blocked, "automation.json", () => ({ a: 0 }));
  await bad.save({ a: 1 });
  assert.match(storageHealth.error ?? "", /Could not save automation\.json/);

  const good = new JsonStore<{ a: number }>(dir, "automation.json", () => ({ a: 0 }));
  await good.save({ a: 2 });
  assert.equal(storageHealth.error, null);
  assert.equal((await good.load()).a, 2, "survives a reload");
});
