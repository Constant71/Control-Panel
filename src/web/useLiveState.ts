import { useEffect, useState } from "react";
import type { PanelState } from "./types";

/** Subscribes to the server's event stream; falls back to polling if it drops. */
export function useLiveState() {
  const [state, setState] = useState<PanelState | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let fallback: number | null = null;
    let closed = false;

    const load = () =>
      fetch("panel-api/state")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((s: PanelState) => setState(s))
        .catch(() => setConnected(false));

    const connect = () => {
      es = new EventSource("panel-api/events");
      es.addEventListener("state", (e) => {
        setState(JSON.parse((e as MessageEvent).data));
        setConnected(true);
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) window.setTimeout(connect, 5000);
      };
    };
    load();
    connect();
    fallback = window.setInterval(() => {
      if (!connected) load();
    }, 15000);
    return () => {
      closed = true;
      es?.close();
      if (fallback) window.clearInterval(fallback);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, connected };
}
