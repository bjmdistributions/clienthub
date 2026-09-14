// DEV ONLY — fixture behind r282-harness.html. Mounts AccountantChanges in a
// Financials-style header against an in-memory stand-in for the server's
// /api/books/changes feed, so the button, the unseen pill and the panel can be
// checked visually in each theme. Nothing in the app imports this.
import ReactDOM from "react-dom/client";
import AccountantChanges from "./components/AccountantChanges";
import "./index.css";

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const txn = { txn_posted_at: "2026-09-05", txn_description: "HILTON DALLAS", txn_amount: 312.4, txn_direction: "out", txn_account_id: "Amex 3001" };
let changes = [
  { id: "c1", bank_txn_id: "t1", user_id: "acct", user_name: "Dana Reyes", field: "note", old_value: "", new_value: "Hotel for the Dallas pickup, 2 nights. Receipt in the shared folder.", created_at: ago(4), seen_at: null, ...txn },
  { id: "c2", bank_txn_id: "t1", user_id: "acct", user_name: "Dana Reyes", field: "category", old_value: "", new_value: "travel", created_at: ago(4), seen_at: null, ...txn },
  { id: "c3", bank_txn_id: "t1", user_id: "acct", user_name: "Dana Reyes", field: "confirmed_method", old_value: "", new_value: "card", created_at: ago(4), seen_at: null, ...txn },
  { id: "c4", bank_txn_id: "t2", user_id: "acct", user_name: "Dana Reyes", field: "reviewed", old_value: "false", new_value: "true", created_at: ago(90), seen_at: ago(60),
    txn_posted_at: "2026-09-02", txn_description: "WIRE IN ACME LIQUIDATORS INV 1043", txn_amount: 18450, txn_direction: "in", txn_account_id: "Chase 1234" },
];

(window as any).__FIXTURE = (cmd: string) => {
  if (cmd === "list_books_changes") return { changes, total: changes.length, unseen: changes.filter((c) => !c.seen_at).length };
  if (cmd === "mark_books_changes_seen") {
    changes = changes.map((c) => ({ ...c, seen_at: c.seen_at ?? new Date().toISOString() }));
    return { ok: true, marked: 3 };
  }
  return null;
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="bg-canvas min-h-screen p-6">
    <div className="min-w-0 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-[19px] font-semibold text-ink tracking-tight truncate">Financials</h2>
          <AccountantChanges />
        </div>
        <p className="text-[12px] text-muted mt-0.5">Book the money that came in and went out</p>
      </div>
    </div>
  </div>,
);
