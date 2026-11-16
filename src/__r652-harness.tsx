// DEV ONLY: the fixture behind harness/r652-harness.html. Nothing in the app imports this and index.html does not
// reference the page, so it never reaches a build. Mounts the REAL To book bank strip and the REAL Setup list of who
// imports each account, on invented banks: one that stopped sharing an account, one whose login broke, one that could
// not be reached. Every value here is invented.
import ReactDOM from "react-dom/client";
import BankHealthStrip from "./components/BankHealthStrip";
import BankFeedOwners from "./components/BankFeedOwners";
import { ToastHost } from "./components/Toast";
import "./index.css";

const q = new URLSearchParams(location.search);
if (q.get("dark") === "1") document.documentElement.classList.add("dark");

const today = new Date().toISOString();
const bank = (id: string, institution: string, extra: Record<string, unknown>) => ({
  id, institution, last_ok: "2026-11-14T15:00:00Z", last_try: today, error: "", code: "", needs_login: false,
  dropped: [], webhook_ok: true, last_ring: null, ...extra,
});

(window as any).__FIXTURE = (cmd: string) => {
  switch (cmd) {
    case "plaid_health":
      return {
        banks: [
          bank("pi_a", "Example Bank", { dropped: [{ name: "Business Savings", mask: "2222", since: "2026-11-10T09:00:00Z" }] }),
          bank("pi_b", "Sample Credit Union", { error: "Plaid: the login details of this item have changed", code: "ITEM_LOGIN_REQUIRED", needs_login: true }),
          bank("pi_c", "Test Card Co", { error: "Plaid: this institution is not responding", code: "INSTITUTION_NOT_RESPONDING" }),
        ],
        warnings: [],
        last_sync: today,
      };
    case "list_overbooked_txns": return [];
    // Fix connection: the browser sign-in "finishes" on the first poll.
    case "plaid_reconnect_start": (window as any).__fixStarted = true; return { hosted_link_url: "about:blank", link_token: "link-test" };
    case "plaid_reconnect_poll": return { status: "done" };
    case "plaid_sync": (window as any).__synced = true; return { imported: 0 };
    case "bank_feed_owners":
      return {
        this_computer: "PC",
        accounts: [
          { key: "example bank|1111", label: "Example Bank · Checking ··1111", here: true, set: true, owner_name: "PC", last_pull: today },
          { key: "test card co|3333", label: "Test Card Co · Card ··3333", here: false, set: true, owner_name: "Mac", last_pull: "2026-11-15T18:20:00Z" },
          { key: "sample credit union|4444", label: "Sample Credit Union · Share ··4444", here: false, set: false, owner_name: "", last_pull: null },
        ],
      };
    default: return null;
  }
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="p-6 max-w-[760px] space-y-6">
    <BankHealthStrip version={0} onSynced={() => {}} />
    <BankFeedOwners version={0} />
    <ToastHost />
  </div>,
);
