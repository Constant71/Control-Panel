import { createRoot } from "react-dom/client";
import { App } from "./App";
import { TvView } from "./TvView";
import { ProjectorView } from "./ProjectorView";
import "./styles.css";

// Kiosk pages have no navigation: the TV dashboard lives at /tv (or #/tv), the projector
// star map at /projector (or #/projector). Options may follow, e.g. /projector?flip=1.
if (/\/(tv|projector)\/$/.test(location.pathname)) history.replaceState(null, "", location.pathname.slice(0, -1) + location.search + location.hash);
const kiosk = (name: string) => new RegExp(`/${name}$`).test(location.pathname) || new RegExp(`^#/?${name}(\\?|$)`).test(location.hash);
const isTv = kiosk("tv");
const isProjector = kiosk("projector");
if (isTv) document.title = "Probe Control TV";
if (isProjector) document.title = "Probe Control Star Map";

createRoot(document.getElementById("root")!).render(isProjector ? <ProjectorView /> : isTv ? <TvView /> : <App />);
