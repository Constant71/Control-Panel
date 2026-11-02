import { useEffect, useState } from "react";
import type { PanelState, Schemas } from "./types";
import { callOp } from "./api";
import { ago } from "./format";

type Msg = Schemas["ProbeMessage"];
type Sent = Schemas["ProbeSentMessage"];
type Page = Schemas["ProbeLogbookPageSummary"];
type Cat = Schemas["ForumCategory"];
type Post = Schemas["ForumPost"];
type FMsg = Schemas["ForumMessage"];

/** Probe messages, logbook and forum, all through the game API. */
export function CommsView({ state, now }: { state: PanelState; now: number }) {
  const [tab, setTab] = useState<"messages" | "logbook" | "forum">("messages");
  return (
    <div className="pad">
      <div className="tabs small">
        <button className={tab === "messages" ? "on" : ""} onClick={() => setTab("messages")}>Messages{state.unreadMessages ? ` (${state.unreadMessages})` : ""}</button>
        <button className={tab === "logbook" ? "on" : ""} onClick={() => setTab("logbook")}>Logbook</button>
        <button className={tab === "forum" ? "on" : ""} onClick={() => setTab("forum")}>Forum</button>
      </div>
      {tab === "messages" && <Messages state={state} now={now} />}
      {tab === "logbook" && <Logbook state={state} now={now} />}
      {tab === "forum" && <Forum now={now} />}
    </div>
  );
}

function ProbePicker({ state, value, onChange }: { state: PanelState; value: number; onChange: (id: number) => void }) {
  return (
    <div className="tabs small">
      {state.snapshot.probes.map((p) => (
        <button key={p.summary.id} className={value === p.summary.id ? "on" : ""} disabled={!p.summary.isReachable} onClick={() => onChange(p.summary.id)}
          title={p.summary.isReachable ? "" : "Out of command range"}>
          {p.summary.name}{state.unreadByProbe?.[String(p.summary.id)] ? ` (${state.unreadByProbe[String(p.summary.id)]})` : ""}
        </button>
      ))}
    </div>
  );
}

function Err({ text }: { text: string | null }) {
  return text ? <p className="warn-text tiny">{text}</p> : null;
}

function Messages({ state, now }: { state: PanelState; now: number }) {
  const first = state.snapshot.probes.find((p) => p.summary.isReachable)?.summary.id ?? 0;
  const [probeId, setProbeId] = useState(first);
  const [box, setBox] = useState<"inbox" | "sent">("inbox");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [sent, setSent] = useState<Sent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [to, setTo] = useState({ type: "probe", id: "" });
  const [text, setText] = useState("");
  const isDefault = probeId === state.snapshot.defaultProbeId;

  const load = async () => {
    setErr(null);
    if (box === "inbox") {
      const r = await callOp("GET /api/probe/{probeId}/messages", { path: { probeId }, query: { limit: 100 } });
      if (r.ok) setMsgs((r.data as { messages: Msg[] }).messages); else setErr(r.error);
    } else {
      const r = await callOp("GET /api/probe/messages/sent", { query: { limit: 100 } });
      if (r.ok) setSent((r.data as { messages: Sent[] }).messages); else setErr(r.error);
    }
  };
  useEffect(() => { load(); }, [probeId, box]);

  const markRead = async (m: Msg) => {
    const r = await callOp("PATCH /api/probe/{probeId}/messages/{messageId}/read", { path: { probeId, messageId: m.id } });
    if (!r.ok) setErr(r.error);
    load();
  };
  const send = async () => {
    const id = /^\d+$/.test(to.id) ? Number(to.id) : to.id;
    const r = await callOp("POST /api/probe/{probeId}/messages", { path: { probeId }, body: { recipient: { type: to.type, id }, body: text } });
    if (r.ok) { setText(""); setBox("sent"); } else setErr(r.error);
    load();
  };
  const planets = ((state.snapshot.probes.find((p) => p.summary.id === probeId)?.sector?.objects ?? []) as Array<Record<string, unknown>>)
    .filter((o) => o.type === "planet");

  return (
    <>
      <ProbePicker state={state} value={probeId} onChange={setProbeId} />
      <div className="tabs small">
        <button className={box === "inbox" ? "on" : ""} onClick={() => setBox("inbox")}>Received</button>
        <button className={box === "sent" ? "on" : ""} onClick={() => setBox("sent")} title="The API lists sent messages for your default probe only">Sent (default probe)</button>
      </div>
      <Err text={err} />
      <div className="card">
        <strong>Send from {state.snapshot.probes.find((p) => p.summary.id === probeId)?.summary.name}</strong>
        <p className="muted tiny">Probes must share this probe's sector or an active SCUT network. Planets must be inhabited and in this sector.</p>
        <div className="addgoal">
          <select value={to.type} onChange={(e) => setTo({ type: e.target.value, id: "" })}>
            <option value="probe">Probe</option><option value="planet">Planet</option>
          </select>
          {to.type === "probe" ? (
            <input placeholder="probe id (any player's)" value={to.id} onChange={(e) => setTo({ ...to, id: e.target.value })} />
          ) : (
            <select value={to.id} onChange={(e) => setTo({ ...to, id: e.target.value })}>
              <option value="">Planet…</option>
              {planets.map((o) => <option key={String(o.id)} value={String(o.id)}>{String(o.name ?? o.id)}</option>)}
            </select>
          )}
        </div>
        <textarea rows={3} maxLength={2000} placeholder="Message (up to 2000 characters)" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="actions"><button className="primary" disabled={!text.trim() || !to.id} onClick={send}>Send</button></div>
      </div>
      {box === "inbox" ? (
        <div className="list">
          {msgs.length === 0 && <p className="muted">No messages.</p>}
          {msgs.map((m) => (
            <div key={m.id} className={`card ${m.status === "unread" ? "warning" : ""}`}>
              <div className="card-h">
                <strong>{m.sender.name}</strong><span className="tag">{m.sender.type} {String(m.sender.id)}</span>
                <span className="muted tiny">{ago(m.createdAt, now)} · sector ({m.sector.relative.x}, {m.sector.relative.y}, {m.sector.relative.z})</span>
                {m.status === "unread" && <button className="tiny" onClick={() => markRead(m)}>Mark read</button>}
              </div>
              <p className="pre">{m.body}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="list">
          {!isDefault && <p className="muted tiny">The API only lists sent messages for your default probe.</p>}
          {sent.map((m) => (
            <div key={m.id} className="card">
              <div className="card-h"><span className="muted tiny">{m.sender.name} →</span> <strong>{m.recipient.name}</strong><span className="muted tiny">{ago(m.createdAt, now)}</span></div>
              <p className="pre">{m.body}</p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Logbook({ state, now }: { state: PanelState; now: number }) {
  const first = state.snapshot.probes.find((p) => p.summary.isReachable)?.summary.id ?? 0;
  const [probeId, setProbeId] = useState(first);
  const [pages, setPages] = useState<Page[]>([]);
  const [open, setOpen] = useState<{ id: number | null; title: string; content: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => {
    setErr(null);
    const r = await callOp("GET /api/probe/{probeId}/logbook-pages", { path: { probeId }, query: { limit: 100 } });
    if (r.ok) setPages((r.data as { pages: Page[] }).pages); else setErr(r.error);
  };
  useEffect(() => { load(); setOpen(null); }, [probeId]);

  const view = async (p: Page) => {
    const r = await callOp("GET /api/probe/{probeId}/logbook-page/{logbookPageId}", { path: { probeId, logbookPageId: p.id } });
    if (r.ok) { const pg = (r.data as { page: Schemas["ProbeLogbookPage"] }).page; setOpen({ id: pg.id, title: pg.title, content: pg.content }); } else setErr(r.error);
  };
  const save = async () => {
    if (!open) return;
    const r = open.id === null
      ? await callOp("POST /api/probe/{probeId}/logbook-page", { path: { probeId }, body: { title: open.title, content: open.content } })
      : await callOp("PATCH /api/probe/{probeId}/logbook-page/{logbookPageId}", { path: { probeId, logbookPageId: open.id }, body: { title: open.title, content: open.content } });
    if (r.ok) setOpen(null); else setErr(r.error);
    load();
  };
  const del = async () => {
    if (!open?.id || !window.confirm(`Delete logbook page "${open.title}"? This can't be undone.`)) return;
    const r = await callOp("DELETE /api/probe/{probeId}/logbook-page/{logbookPageId}", { path: { probeId, logbookPageId: open.id }, confirmed: true });
    if (r.ok) setOpen(null); else setErr(r.error);
    load();
  };

  return (
    <>
      <ProbePicker state={state} value={probeId} onChange={setProbeId} />
      <Err text={err} />
      {open ? (
        <div className="card">
          <input className="title" maxLength={120} value={open.title} placeholder="Title" onChange={(e) => setOpen({ ...open, title: e.target.value })} />
          <textarea rows={12} maxLength={20000} value={open.content} placeholder="Page content" onChange={(e) => setOpen({ ...open, content: e.target.value })} />
          <div className="actions">
            <button className="primary" disabled={!open.title.trim() || !open.content.trim()} onClick={save}>Save</button>
            <button onClick={() => setOpen(null)}>Close</button>
            {open.id !== null && <button className="danger" onClick={del}>Delete</button>}
          </div>
        </div>
      ) : (
        <>
          <div className="actions"><button className="primary" onClick={() => setOpen({ id: null, title: "", content: "" })}>New page</button></div>
          <div className="list mt">
            {pages.length === 0 && <p className="muted">No logbook pages for this probe.</p>}
            {pages.map((p) => (
              <div key={p.id} className="card clickable" onClick={() => view(p)}>
                <strong>{p.title}</strong> <span className="muted tiny">edited {ago(p.updatedAt, now)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Forum({ now }: { now: number }) {
  const [cats, setCats] = useState<Cat[]>([]);
  const [cat, setCat] = useState<number | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [post, setPost] = useState<{ post: Post; first: FMsg | null; replies: FMsg[] } | null>(null);
  const [draft, setDraft] = useState({ title: "", body: "" });
  const [reply, setReply] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    callOp("GET /api/forum/categories").then((r) => {
      if (r.ok) { const c = (r.data as { categories: Cat[] }).categories; setCats(c); setCat(c[0]?.id ?? null); } else setErr(r.error);
    });
  }, []);
  const loadPosts = async () => {
    if (cat === null) return;
    const r = await callOp("GET /api/forum/posts", { query: { categoryId: cat, limit: 50 } });
    if (r.ok) setPosts((r.data as { posts: Post[] }).posts); else setErr(r.error);
  };
  useEffect(() => { loadPosts(); setPost(null); }, [cat]);
  const openPost = async (id: number) => {
    const r = await callOp("GET /api/forum/posts/{postId}", { path: { postId: id } });
    const m = await callOp("GET /api/forum/posts/{postId}/messages", { path: { postId: id }, query: { limit: 100 } });
    if (r.ok) {
      const d = r.data as { post: Post; firstMessage: FMsg | null };
      const replies = m.ok ? (m.data as { messages: FMsg[] }).messages.filter((x) => x.id !== d.firstMessage?.id) : [];
      setPost({ post: d.post, first: d.firstMessage, replies });
    } else setErr(r.error);
  };
  const createPost = async () => {
    const r = await callOp("POST /api/forum/posts", { body: { categoryId: cat, title: draft.title, body: draft.body } });
    if (r.ok) { setDraft({ title: "", body: "" }); loadPosts(); } else setErr(r.error);
  };
  const sendReply = async () => {
    if (!post) return;
    const r = await callOp("POST /api/forum/posts/{postId}/messages", { path: { postId: post.post.id }, body: { body: reply } });
    if (r.ok) { setReply(""); openPost(post.post.id); } else setErr(r.error);
  };

  return (
    <>
      <Err text={err} />
      <div className="tabs small">
        {cats.map((c) => <button key={c.id} className={cat === c.id ? "on" : ""} onClick={() => setCat(c.id)} title={c.description ?? undefined}>{c.name}</button>)}
      </div>
      {post ? (
        <div className="list">
          <p><button onClick={() => setPost(null)}>← Posts</button></p>
          <div className="card">
            <strong>{post.post.title}</strong>
            {post.first && <ForumMsg m={post.first} now={now} />}
          </div>
          {post.replies.map((m) => <div key={m.id} className="card"><ForumMsg m={m} now={now} /></div>)}
          <div className="card">
            <textarea rows={3} maxLength={5000} placeholder="Reply (up to 5000 characters)" value={reply} onChange={(e) => setReply(e.target.value)} />
            <div className="actions"><button className="primary" disabled={!reply.trim()} onClick={sendReply}>Reply</button></div>
          </div>
        </div>
      ) : (
        <>
          <div className="list">
            {posts.length === 0 && <p className="muted">No posts in this category.</p>}
            {posts.map((p) => (
              <div key={p.id} className="card clickable" onClick={() => openPost(p.id)}>
                {p.pinned && <span className="tag">pinned</span>} <strong>{p.title}</strong>
                <div className="muted tiny">{p.author.displayName ?? p.author.username} · {p.messageCount} message(s) · last {ago(p.lastMessageAt, now)}</div>
              </div>
            ))}
          </div>
          {cat !== null && (
            <div className="card mt">
              <strong>New post</strong>
              <input className="title" maxLength={160} placeholder="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              <textarea rows={4} maxLength={5000} placeholder="Body" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              <div className="actions"><button className="primary" disabled={!draft.title.trim() || !draft.body.trim()} onClick={createPost}>Post</button></div>
            </div>
          )}
        </>
      )}
    </>
  );
}

function ForumMsg({ m, now }: { m: FMsg; now: number }) {
  return (
    <>
      <div className="muted tiny">{m.author.displayName ?? m.author.username} · {ago(m.createdAt, now)}{m.editedAt ? " · edited" : ""}</div>
      <p className="pre">{m.body}</p>
    </>
  );
}
