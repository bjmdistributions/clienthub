// DEV ONLY: the fixture behind harness/r668-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Mounts the REAL EIN lock (R-668) on an invented EIN.
// ?start=plain (plain EIN saved), ?start=none, default locked. The password here is "correct horse battery".
import ReactDOM from "react-dom/client";
import { EinLock } from "./components/SettingsView";
import { ToastHost } from "./components/Toast";
import "./index.css";

const q = new URLSearchParams(location.search);
if (q.get("dark") === "1") document.documentElement.classList.add("dark");
const start = q.get("start");
let locked = start !== "plain" && start !== "none";
let plain: string | null = start === "plain" ? "12-3456789" : null;
let ein = "12-3456789", pass = "correct horse battery";

(window as any).__FIXTURE = (cmd: string, a: any) => {
  switch (cmd) {
    case "ein_lock_status": return { locked, plain: locked ? null : plain };
    case "ein_lock_open":
      if (a.password !== pass) throw "That password is not right.";
      return ein;
    case "ein_lock_save":
      if (locked && a.current !== null && a.current !== pass) throw "Your current EIN password is not right.";
      ein = a.ein; pass = a.password; locked = true; plain = null; return null;
    default: return null;
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="p-8 max-w-2xl bg-bg min-h-screen text-ink">
    <EinLock onLocked={() => {}} />
    <ToastHost />
  </div>,
);
