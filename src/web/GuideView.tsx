import { Fragment, useMemo } from "react";
import guideText from "../../docs/GUIDE.md?raw";
import { parseMarkdown, type Block, type Inline, type ListItem } from "../shared/markdown";

const REPO = "https://github.com/Constant71/Control-Panel/blob/main/";

/** The user guide (docs/GUIDE.md), built into the panel so it's always the version that's running. */
export function GuideView() {
  const blocks = useMemo(() => parseMarkdown(guideText), []);
  return (
    <div className="pad guide">
      {blocks.map((b, i) => <BlockView key={i} b={b} />)}
    </div>
  );
}

function jump(id: string) {
  document.getElementById(`guide-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case "h": {
      const Tag = `h${Math.min(b.level + 1, 6)}` as "h2";
      return <Tag id={`guide-${b.id}`}><Inlines c={b.c} /></Tag>;
    }
    case "p": return <p><Inlines c={b.c} /></p>;
    case "hr": return <hr />;
    case "ul": return <ul>{b.items.map((it, i) => <Item key={i} it={it} />)}</ul>;
    case "ol": return <ol>{b.items.map((it, i) => <Item key={i} it={it} />)}</ol>;
    case "table":
      return (
        <div className="table-wrap">
          <table>
            <thead><tr>{b.head.map((c, i) => <th key={i}><Inlines c={c} /></th>)}</tr></thead>
            <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Inlines c={c} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
  }
}

function Item({ it }: { it: ListItem }) {
  return (
    <li>
      <Inlines c={it.c} />
      {it.children.length > 0 && <ul>{it.children.map((c, i) => <Item key={i} it={c} />)}</ul>}
    </li>
  );
}

function Inlines({ c }: { c: Inline[] }) {
  return <>{c.map((x, i) => <Fragment key={i}>{inline(x)}</Fragment>)}</>;
}

function inline(x: Inline) {
  switch (x.t) {
    case "text": return x.v;
    case "code": return <code>{x.v}</code>;
    case "b": return <strong><Inlines c={x.c} /></strong>;
    case "i": return <em><Inlines c={x.c} /></em>;
    case "a": {
      if (x.href.startsWith("#")) {
        // In-page anchor: scroll instead of changing the panel's hash route.
        const id = x.href.slice(1);
        return <a href={`#/guide`} onClick={(e) => { e.preventDefault(); jump(id); }}><Inlines c={x.c} /></a>;
      }
      const href = /^https?:/.test(x.href) ? x.href : REPO + x.href.replace(/^(\.\.\/)+/, "");
      return <a href={href} target="_blank" rel="noreferrer"><Inlines c={x.c} /></a>;
    }
  }
}
