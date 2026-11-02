/**
 * A small Markdown parser for the in-panel user guide (docs/GUIDE.md). It covers what the guide uses:
 * headings, paragraphs, bullet and numbered lists (one nesting level), tables, rules, and inline
 * bold, italic, code and links. It returns plain data, so the page renders it with React and no raw HTML.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "b"; c: Inline[] }
  | { t: "i"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "a"; href: string; c: Inline[] };

export interface ListItem { c: Inline[]; children: ListItem[] }

export type Block =
  | { t: "h"; level: number; id: string; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "ul" | "ol"; items: ListItem[] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

/** GitHub-style heading anchor: lower case, punctuation dropped, spaces to dashes. */
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s/g, "-");
}

export function plain(c: Inline[]): string {
  return c.map((x) => (x.t === "text" || x.t === "code" ? x.v : plain(x.c))).join("");
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => { if (buf) out.push({ t: "text", v: buf }); buf = ""; };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue; }
    if (ch === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i) { flush(); out.push({ t: "code", v: s.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (s.startsWith("**", i)) {
      const end = s.indexOf("**", i + 2);
      if (end > i + 2) { flush(); out.push({ t: "b", c: parseInline(s.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    if (ch === "*" && /\S/.test(s[i + 1] ?? "")) {
      const end = s.indexOf("*", i + 1);
      if (end > i + 1) { flush(); out.push({ t: "i", c: parseInline(s.slice(i + 1, end)) }); i = end + 1; continue; }
    }
    if (ch === "[") {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
      if (m) { flush(); out.push({ t: "a", href: m[2], c: parseInline(m[1]) }); i += m[0].length; continue; }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => parseInline(c.trim()));
const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const c = parseInline(h[2].trim());
      blocks.push({ t: "h", level: h[1].length, id: slug(plain(c)), c });
      i++;
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { blocks.push({ t: "hr" }); i++; continue; }
    if (line.trim().startsWith("|") && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
      const head = cells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      blocks.push({ t: "table", head, rows });
      continue;
    }
    const lm = LIST.exec(line);
    if (lm) {
      const ordered = /\d/.test(lm[2]);
      const baseIndent = lm[1].length;
      const items: ListItem[] = [];
      let last: ListItem | null = null;
      while (i < lines.length) {
        const l = lines[i];
        const m = LIST.exec(l);
        if (m && m[1].length <= baseIndent + 1) {
          if (/\d/.test(m[2]) !== ordered) break;
          last = { c: parseInline(m[3]), children: [] };
          items.push(last);
          i++;
        } else if (m && items.length) {
          last = { c: parseInline(m[3]), children: [] };
          items[items.length - 1].children.push(last);
          i++;
        } else if (last && l.trim() && /^\s+/.test(l)) {
          last.c.push({ t: "text", v: " " }, ...parseInline(l.trim())); // continuation line
          i++;
        } else if (!l.trim() && items.length && LIST.exec(lines[i + 1] ?? "") && LIST.exec(lines[i + 1])![1].length > baseIndent) {
          i++; // blank line before a nested item
        } else break;
      }
      blocks.push({ t: ordered ? "ol" : "ul", items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s/.test(lines[i]) && !LIST.exec(lines[i]) && !lines[i].trim().startsWith("|") && !/^\s*---+\s*$/.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ t: "p", c: parseInline(para.join(" ")) });
  }
  return blocks;
}
