import { useState } from "react";
import { IntakeSourceSummary } from "../lib/api";
import { ArrowLeft, ArrowRight, ArrowDown, Copy, Check, Code2, MousePointerClick, ShoppingBag, FileInput, Sparkles } from "lucide-react";

// A visual, on-brand setup guide for turning any website form into pending
// Ecliptr leads. Illustrations are stylized mock UI blocks (NOT screenshots).

function useCopy(): [boolean, (v: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (v: string) => { navigator.clipboard?.writeText(v).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  return [copied, copy];
}

// Numbered step marker.
function StepNum({ n }: { n: number }) {
  return <span className="flex-shrink-0 w-6 h-6 rounded-full bg-accent text-on-accent text-[12px] font-bold flex items-center justify-center">{n}</span>;
}

// A stylized "browser card" wrapper for mock UI illustrations.
function MockWindow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 overflow-hidden shadow-sm">
      <div className="flex items-center gap-1.5 px-3 h-7 border-b border-line bg-surface">
        <span className="w-2 h-2 rounded-full bg-line-3" />
        <span className="w-2 h-2 rounded-full bg-line-3" />
        <span className="w-2 h-2 rounded-full bg-line-3" />
        <span className="ml-2 text-[10px] text-faint truncate">{title}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// The illustrated flow: a form → arrow → a new pending lead in Ecliptr.
function FlowIllustration() {
  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
      <div className="flex-1">
        <MockWindow title="yourstore.com/contact">
          <div className="space-y-2">
            <div className="h-2.5 w-20 rounded bg-line-3" />
            <div className="h-8 rounded-md border border-line bg-surface" />
            <div className="h-8 rounded-md border border-line bg-surface" />
            <div className="h-8 rounded-md border border-line bg-surface" />
            <div className="h-8 w-24 rounded-md bg-accent flex items-center justify-center text-on-accent text-[11px] font-semibold">Submit</div>
          </div>
        </MockWindow>
      </div>
      <div className="flex sm:flex-col items-center justify-center text-accent">
        <ArrowRight size={22} className="hidden sm:block" />
        <ArrowDown size={22} className="sm:hidden" />
        <span className="text-[10px] font-medium text-muted mt-1 hidden sm:block">POST</span>
      </div>
      <div className="flex-1">
        <MockWindow title="Ecliptr · Approvals">
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-full bg-success-bg text-success-ink flex items-center justify-center text-[13px] font-bold">JD</span>
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-ink">New pending lead</div>
              <div className="text-[10.5px] text-muted">jane@acme.com · from your website</div>
            </div>
            <span className="ml-auto text-[9px] font-bold uppercase tracking-wide text-accent-hover bg-accent/10 px-1.5 py-0.5 rounded">Pending</span>
          </div>
        </MockWindow>
      </div>
    </div>
  );
}

export function SetupGuide({ source, baseUrl, onBack }: {
  source: IntakeSourceSummary | null; baseUrl: string; onBack: () => void;
}) {
  const [tab, setTab] = useState<"html" | "nocode" | "shopify">("html");
  const [copied, copy] = useCopy();

  // Use the real source URL when we came from a specific form; else a clear placeholder.
  const url = source?.url || (baseUrl ? `${baseUrl}<your-token>` : "https://your-ecliptr-host/api/intake/<your-token>");
  const snippet = `<form action="${url}" method="post">
  <!-- honeypot: bots fill this, humans don't. Leave it hidden. -->
  <input type="text" name="website" style="display:none" tabindex="-1" autocomplete="off">

  <input type="text"  name="first_name" placeholder="First name">
  <input type="text"  name="last_name"  placeholder="Last name">
  <input type="email" name="email"       placeholder="Email" required>
  <input type="tel"   name="phone"       placeholder="Phone">
  <input type="text"  name="company"     placeholder="Company">
  <textarea           name="notes"       placeholder="How can we help?"></textarea>

  <!-- optional: send the visitor to a thank-you page after submit -->
  <input type="hidden" name="_redirect" value="https://yourstore.com/thank-you">

  <button type="submit">Send</button>
</form>`;

  const TABS: [typeof tab, string, typeof Code2][] = [
    ["html", "Custom HTML form", Code2],
    ["nocode", "No-code builders", MousePointerClick],
    ["shopify", "Shopify", ShoppingBag],
  ];

  return (
    <div className="max-w-[900px]">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink mb-4 transition-colors">
        <ArrowLeft size={14} /> Back to automations
      </button>

      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={16} className="text-accent" />
        <h2 className="text-[18px] font-bold text-ink">Connect a web form</h2>
      </div>
      <p className="text-[12.5px] text-muted mb-5">
        {source ? <>Point any form at <span className="text-ink-2 font-medium">{source.name}</span> and submissions arrive as pending leads.</> : "Point any website form at your intake URL and submissions arrive as pending leads."}
      </p>

      {/* The mental model, up front */}
      <div className="bg-surface border border-line rounded-xl p-5 mb-5">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-muted mb-3">The flow</div>
        <FlowIllustration />
        <p className="text-[12px] text-muted mt-4 leading-relaxed">
          Every submission becomes a <span className="text-ink-2 font-medium">pending lead</span> in your Approvals queue — nothing is added to your client list until you approve it. Unknown fields are kept on the lead's record.
        </p>
      </div>

      {/* Method tabs */}
      <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5 w-fit mb-4">
        {TABS.map(([v, label, Icon]) => (
          <button key={v} onClick={() => setTab(v)}
            className={`inline-flex items-center gap-1.5 px-3.5 h-8 rounded-md text-[12.5px] font-medium transition-colors ${tab === v ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink-2"}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {tab === "html" && (
        <div className="space-y-4">
          <StepRow n={1} title="Copy this form snippet">
            <p className="text-[12px] text-muted mb-2.5">
              Paste it into your site's HTML. The <code className="text-ink-2 bg-surface-2 px-1 rounded">action</code> is already set to your intake URL — no JavaScript needed.
            </p>
            <div className="relative">
              <pre className="bg-surface-2 border border-line rounded-lg p-3.5 pr-24 text-[11.5px] text-ink-2 overflow-x-auto font-mono leading-relaxed">{snippet}</pre>
              <button onClick={() => copy(snippet)}
                className="absolute top-2.5 right-2.5 inline-flex items-center gap-1 bg-accent hover:bg-accent-hover text-on-accent px-2.5 h-7 rounded-md text-[11px] font-medium">
                {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
              </button>
            </div>
          </StepRow>

          <StepRow n={2} title="Name the inputs so fields map cleanly">
            <p className="text-[12px] text-muted mb-2">Ecliptr recognizes these <code className="text-ink-2 bg-surface-2 px-1 rounded">name</code> attributes:</p>
            <div className="flex flex-wrap gap-1.5">
              {["email", "name", "first_name", "last_name", "phone", "company", "notes"].map((f) => (
                <span key={f} className="text-[11px] font-mono text-accent bg-accent/10 border border-accent/20 px-2 py-0.5 rounded">{f}</span>
              ))}
            </div>
            <p className="text-[11.5px] text-muted mt-2.5">Any other field names are preserved on the lead's record as extra details.</p>
          </StepRow>

          <StepRow n={3} title="Optional niceties" last>
            <ul className="space-y-2 text-[12px] text-muted">
              <li className="flex gap-2">
                <span className="text-accent font-mono text-[11px] mt-0.5">_redirect</span>
                <span>A hidden input — after submitting, the visitor is sent (303) to this thank-you URL.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-accent font-mono text-[11px] mt-0.5">website</span>
                <span>A hidden honeypot. Real people leave it blank; bots that fill it are silently dropped. Keep it hidden.</span>
              </li>
            </ul>
          </StepRow>
        </div>
      )}

      {tab === "nocode" && (
        <div className="space-y-4">
          <div className="bg-surface border border-line rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <FileInput size={15} className="text-muted" />
              <span className="text-[13px] font-semibold text-ink">Google Forms, Typeform, Jotform &amp; friends</span>
            </div>
            <p className="text-[12px] text-muted leading-relaxed">
              Most builders can POST to a custom endpoint (via their "webhook", "redirect on submit", or integration settings). Set the destination to your intake URL and map their fields to the names above. If a builder only supports Zapier/Make, point that automation's webhook at the same URL.
            </p>
          </div>

          <StepRow n={1} title="Set the form's POST target">
            <div className="flex items-center gap-2 min-w-0">
              <code className="flex-1 bg-surface-2 border border-line rounded-md h-8 px-2.5 text-[11.5px] text-ink-2 truncate flex items-center font-mono">{url}</code>
              <button onClick={() => copy(url)} className="flex-shrink-0 inline-flex items-center gap-1 border border-line px-2.5 h-8 rounded-md text-[11.5px] text-ink-2 hover:bg-surface-2 transition-colors">
                {copied ? <><Check size={12} className="text-success-ink" /> Copied</> : <><Copy size={12} /> Copy</>}
              </button>
            </div>
          </StepRow>

          <StepRow n={2} title="Static sites (Webflow, Framer, plain HTML)" last>
            <p className="text-[12px] text-muted leading-relaxed">
              Set the form element's <code className="text-ink-2 bg-surface-2 px-1 rounded">action</code> attribute to the URL above and its <code className="text-ink-2 bg-surface-2 px-1 rounded">method</code> to <code className="text-ink-2 bg-surface-2 px-1 rounded">post</code> — exactly like the HTML snippet. No backend or plugin required.
            </p>
          </StepRow>
        </div>
      )}

      {tab === "shopify" && (
        <div className="space-y-4">
          <p className="text-[12px] text-muted">There are two ways to bring Shopify leads into Ecliptr — pick either or both.</p>

          <div className="bg-surface border border-line rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-6 h-6 rounded-md bg-accent/10 text-accent-hover flex items-center justify-center text-[12px] font-bold">A</span>
              <span className="text-[13px] font-semibold text-ink">Customer signups (automatic)</span>
            </div>
            <p className="text-[12px] text-muted leading-relaxed">
              Use the built-in Shopify integration: when a customer account is created in your store, it flows into Ecliptr as a pending lead automatically. Connect it once under <span className="text-ink-2 font-medium">Settings → Shopify</span> (paste your store's webhook secret). No form edits needed.
            </p>
          </div>

          <div className="bg-surface border border-line rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-6 h-6 rounded-md bg-gradient-to-br from-accent/20 to-accent/5 text-accent-hover flex items-center justify-center text-[12px] font-bold">B</span>
              <span className="text-[13px] font-semibold text-ink">Contact / lead forms on your storefront</span>
            </div>
            <p className="text-[12px] text-muted leading-relaxed mb-3">
              For a contact form on a Shopify page, add a <span className="text-ink-2 font-medium">Custom Liquid</span> section (or edit the theme) and drop in the HTML form from the "Custom HTML form" tab, with its <code className="text-ink-2 bg-surface-2 px-1 rounded">action</code> set to your intake URL.
            </p>
            <ol className="space-y-2.5">
              {[
                <>In Shopify admin, open <span className="text-ink-2">Online Store → Themes → Customize</span>.</>,
                <>Add a <span className="text-ink-2">Custom Liquid</span> block to your contact page.</>,
                <>Paste the HTML form snippet; keep the field <code className="text-ink-2 bg-surface-2 px-1 rounded">name</code> values as-is.</>,
                <>Save. Test a submission — it lands in your <span className="text-ink-2">Approvals</span> queue.</>,
              ].map((t, i) => (
                <li key={i} className="flex gap-2.5 items-start text-[12px] text-muted">
                  <StepNum n={i + 1} /> <span className="mt-0.5 leading-relaxed">{t}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

function StepRow({ n, title, children, last }: { n: number; title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <StepNum n={n} />
        {!last && <div className="w-px flex-1 bg-line-2 my-1" />}
      </div>
      <div className={`flex-1 ${last ? "" : "pb-1"}`}>
        <div className="text-[13px] font-semibold text-ink mb-1.5">{title}</div>
        {children}
      </div>
    </div>
  );
}
