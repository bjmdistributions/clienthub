import { useState } from "react";
import { X, ArrowRight, ArrowLeft, Users, GitBranch, Truck, Mail } from "lucide-react";

const STEPS = [
  { icon: null, title: "Welcome to Ecliptr", body: "Run your whole wholesale business in one place: clients, deals, suppliers, invoicing and newsletters. Here's a quick tour of how the pieces fit together." },
  { icon: Users, title: "Clients & leads", body: "Every client lives here. New leads from your website forms, Shopify, or imports arrive as pending. You review and approve them before they're added." },
  { icon: GitBranch, title: "Deal flow", body: "Deals move from invoiced → payment received → supplier paid → closed. Ecliptr works out the profit and each rep's pay split automatically as you advance them." },
  { icon: Truck, title: "Suppliers & inventory", body: "Track who you source from and what's in stock. Supplier costs flow into each deal's profit, so your numbers stay accurate." },
  { icon: Mail, title: "Reach your customers", body: "Send newsletters to your client list and build custom intake forms, so submissions come straight back in as new leads." },
];

export default function GettingStarted({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const Icon = step.icon;
  const last = i === STEPS.length - 1;
  const finish = () => { try { localStorage.setItem("ec_welcome_desktop_v1", "1"); } catch { /* ignore */ } onDone(); };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex justify-end px-4 pt-4">
          <button onClick={finish} className="text-muted hover:text-ink transition-colors text-[12px] flex items-center gap-1"><X size={14} /> Skip</button>
        </div>
        <div className="px-8 pt-1 text-center">
          {Icon ? (
            <Icon size={28} className="mx-auto mb-5 text-ink" />
          ) : (
            // Welcome step leads with THE app mark (same asset as auth/sidebar).
            <img src="/ecliptr-mark.svg" alt="Ecliptr" className="mx-auto mb-5 w-14 h-14" />
          )}
          <h2 className="text-[18px] font-semibold text-ink mb-2 tracking-tight">{step.title}</h2>
          <p className="text-[13.5px] text-muted leading-relaxed">{step.body}</p>
        </div>
        <div className="flex items-center justify-center gap-1.5 py-6">
          {STEPS.map((_, idx) => (
            <span key={idx} className={`h-1.5 rounded-full transition-all ${idx === i ? "w-5 bg-accent" : "w-1.5 bg-line-3"}`} />
          ))}
        </div>
        <div className="flex items-center justify-between px-6 py-4 border-t border-line">
          <button onClick={() => setI((n) => Math.max(0, n - 1))} disabled={i === 0}
            className="flex items-center gap-1 text-[13px] text-muted hover:text-ink disabled:opacity-0 transition-colors">
            <ArrowLeft size={15} /> Back
          </button>
          <button onClick={() => (last ? finish() : setI((n) => n + 1))}
            className="ui-btn ui-btn-ink gap-1.5 !px-5">
            {last ? "Get started" : "Next"} {!last && <ArrowRight size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}
