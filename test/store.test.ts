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

test("saves made at the same time never corrupt the file; the newest value wins", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "store-"));
  const s = new JsonStore<{ v: string; n: number }>(dir, "stations.json", () => ({ v: "", n: -1 }));
  for (let round = 0; round < 20; round++) {
    await Promise.all(Array.from({ length: 5 }, (_, i) => s.save({ v: "y".repeat(100_000 * (5 - i)), n: round * 10 + i })));
    const loaded = await s.load();
    assert.equal(loaded.n, round * 10 + 4, "the last save is what's on disk");
  }
  assert.equal(storageHealth.error, null);
});

test("a damaged file is recovered from the backup instead of starting empty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "store-"));
  const s = new JsonStore<{ n: number }>(dir, "automation.json", () => ({ n: 0 }));
  await s.save({ n: 1 });
  await s.save({ n: 2 }); // automation.json.bak now holds n: 1
  await writeFile(path.join(dir, "automation.json"), '{"n": 2, "broken');
  assert.equal((await s.load()).n, 1);
  assert.match(storageHealth.error ?? "", /automation\.json was damaged/);
  storageHealth.error = null;
});

test("a value changed after save() is called is saved as it was at the call", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "store-"));
  const s = new JsonStore<{ list: number[] }>(dir, "x.json", () => ({ list: [] }));
  const v = { list: [1] };
  const done = s.save(v);
  v.list.push(2);
  await done;
  assert.deepEqual((await s.load()).list, [1]);
});
