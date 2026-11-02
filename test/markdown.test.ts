import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMarkdown, parseInline, plain, slug, type ListItem } from "../src/shared/markdown.ts";

test("inline bold, italic, code and links", () => {
  const c = parseInline("Press **Do it**, tick *auto*, call `GET /x` or see [Stations](#stations).");
  assert.deepEqual(c.map((x) => x.t), ["text", "b", "text", "i", "text", "code", "text", "a", "text"]);
  assert.equal(plain(c), "Press Do it, tick auto, call GET /x or see Stations.");
});

test("headings get GitHub-style anchors", () => {
  assert.equal(slug("System, debug export and updates"), "system-debug-export-and-updates");
  assert.equal(slug("Fleet and the probe page"), "fleet-and-the-probe-page");
});

test("lists with nesting and continuation lines, tables and rules", () => {
  const b = parseMarkdown(`# T\n\n- one\n  more\n  - child\n- two\n\n1. a\n2. b\n\n| A | B |\n| --- | --- |\n| x | **y** |\n\n---\n\ntext\nwraps`);
  assert.deepEqual(b.map((x) => x.t), ["h", "ul", "ol", "table", "hr", "p"]);
  const ul = b[1] as { items: ListItem[] };
  assert.equal(ul.items.length, 2);
  assert.equal(plain(ul.items[0].c), "one more");
  assert.equal(plain(ul.items[0].children[0].c), "child");
  const p = b[5] as Extract<typeof b[number], { t: "p" }>;
  assert.equal(plain(p.c), "text wraps");
});

test("every in-page link in the guide points at a real heading", () => {
  const blocks = parseMarkdown(readFileSync(new URL("../docs/GUIDE.md", import.meta.url), "utf8"));
  const ids = new Set(blocks.flatMap((b) => (b.t === "h" ? [b.id] : [])));
  const links: string[] = [];
  const walk = (c: unknown): void => {
    if (Array.isArray(c)) return c.forEach(walk);
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      if (o.t === "a" && typeof o.href === "string" && o.href.startsWith("#")) links.push(o.href.slice(1));
      Object.values(o).forEach(walk);
    }
  };
  walk(blocks);
  assert.ok(links.length > 10);
  for (const l of links) assert.ok(ids.has(l), `broken guide link #${l}`);
});
