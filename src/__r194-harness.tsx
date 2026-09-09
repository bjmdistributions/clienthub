// DEV ONLY — fixture behind r194-harness.html, verifying the R-194 "send from"
// picker: hides itself with 0/1 configured address, shows a dropdown with 2+.
// Nothing in the app imports this and index.html does not reference the page,
// so it never reaches a build.
import { useState } from "react";
import ReactDOM from "react-dom/client";
import { FromPicker, useSendFromOptions } from "./components/FromPicker";
import "./index.css";

const n = Number(new URLSearchParams(location.search).get("n") || "2");
const ALL = [
  { address: "jack@bjmdistributions.com", label: "Default" },
  { address: "sales@bjmdistributions.com", label: "Sales" },
  { address: "invoices@bjmdistributions.com", label: "Invoices" },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__FIXTURE = (cmd: string) => {
  if (cmd === "get_send_from_options") return ALL.slice(0, n);
  return null;
};

function Harness() {
  const options = useSendFromOptions();
  const [value, setValue] = useState<string | undefined>(undefined);
  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="text-[12px] text-muted">?n={n} configured address{n === 1 ? "" : "es"} — picker {options.length < 2 ? "should be hidden" : "should show"}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="bg-accent text-on-accent" style={{ height: 36, padding: "0 16px", borderRadius: 8, border: "none" }}>Send</button>
        <FromPicker options={options} value={value} onChange={setValue} />
      </div>
      <div style={{ fontSize: 12 }}>Chosen: {value ?? "(default)"}</div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Harness />);
