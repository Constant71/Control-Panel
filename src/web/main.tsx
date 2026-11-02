import { createRoot } from "react-dom/client";
import { App } from "./App";
import { TvView } from "./TvView";
import "./styles.css";

// The TV / kiosk dashboard lives at /tv (or #/tv) and has no navigation.
if (location.pathname.endsWith("/tv/")) history.replaceState(null, "", location.pathname.slice(0, -1) + location.search + location.hash);
const isTv = /\/tv$/.test(location.pathname) || /^#\/?tv$/.test(location.hash);
if (isTv) document.title = "Probe Control TV";

createRoot(document.getElementById("root")!).render(isTv ? <TvView /> : <App />);
