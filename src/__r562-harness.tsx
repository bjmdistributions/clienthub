// DEV ONLY: the fixture behind r562-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Renders the REAL Settings screen on its Google Calendar
// tab with invented data. ?state=off shows it before Google is connected. Every call is kept in window.__calls.
import ReactDOM from "react-dom/client";
import SettingsView from "./components/SettingsView";
import { ToastHost } from "./components/Toast";
import type { Me } from "./lib/api";
import "./index.css";

type A = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const calls: A[] = [];
(window as unknown as { __calls: A[] }).__calls = calls;
const mode = new URLSearchParams(location.search).get("state") || "";
const off = mode === "off" || mode === "owner";

const state: A = {
  app_set: !off,
  owner: mode === "owner",
  client_id: off ? "" : "123456-abc.apps.googleusercontent.com",
  connected: !off,
  account_email: off ? "" : "ops@example-freight.com",
  connected_at: off ? "" : "2026-10-28T14:02:00Z",
  last_sync_at: off ? "" : "2026-10-28T14:06:00Z",
  last_error: "",
  events: { main: 143, logistics: 38 },
  callback: "https://api.example-freight.com/api/calendar/callback",
  people: [
    { staff_id: "s1", name: "Pat Rivera", email: "ops@example-freight.com", may_main: true, may_logistics: true, main: false, logistics: false, main_shared: false, logistics_shared: false, is_account: true },
    { staff_id: "s2", name: "Sam Okafor", email: "sam@example-freight.com", may_main: true, may_logistics: true, main: true, logistics: false, main_shared: true, logistics_shared: false, is_account: false },
    { staff_id: "s3", name: "Dale Novak", email: "dispatch.dale.novak@example-freight.com", may_main: false, may_logistics: true, main: false, logistics: true, main_shared: true, logistics_shared: true, is_account: false },
  ],
};

(window as unknown as { __FIXTURE: (cmd: string, args: A) => unknown }).__FIXTURE = (cmd, args) => {
  calls.push({ cmd, args });
  if (cmd === "google_calendar") {
    if (args.action === "share") {
      const p = state.people.find((x: A) => x.staff_id === args.body.staff_id);
      if (p) p[args.body.calendar] = args.body.on;
    }
    return JSON.parse(JSON.stringify(state));
  }
  return null;
};

localStorage.setItem("clienthub_settings_tab", "calendar");
const me = { id: "s1", display_name: "Pat Rivera", email: "ops@example-freight.com", permissions: ["*"] } as unknown as Me;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="p-6 bg-canvas min-h-screen">
    <SettingsView me={me} />
    <ToastHost />
  </div>,
);
