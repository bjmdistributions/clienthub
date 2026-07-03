import { useState } from "react";
import { api, Client } from "../lib/api";
import { X, Check, Ban, Mail, Phone, Building2, User, FileText, MapPin, BadgeCheck, UserCog, Tag } from "lucide-react";

// Metadata keys that are system bookkeeping, or that we surface as their own
// labeled fields below — so they don't also appear in the raw "extra" list.
const SYSTEM_META = new Set(["source", "intake_source_id", "shopify_id", "lead_source"]);
const PROMOTED_META = new Set(["first_name", "last_name", "title", "tax_id", "sales_rep", "categories"]);

function sourceLabel(m: Record<string, any> | null): string {
  const s = String(m?.source || "");
  if (s === "shopify") return "Shopify";
  if (s === "intake") return "Web form";
  if (s === "form") return "Ecliptr form";
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Manual";
}

const labelCls = "flex items-center gap-1.5 text-[12.5px] font-medium text-muted mb-1";
const inputCls = "w-full bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors";
const sectionCls = "text-[12.5px] font-medium text-muted";

export default function PendingReviewModal({ client, onClose, onResolved }: {
  client: Client;
  onClose: () => void;
  onResolved: () => void;
}) {
  const meta0 = client.metadata || {};
  const extraKeys = Object.keys(meta0).filter((k) => !SYSTEM_META.has(k) && !PROMOTED_META.has(k));
  const mv = (k: string) => (meta0[k] == null ? "" : String(meta0[k]));

  // Core
  const [name, setName] = useState(client.name || "");
  const [firstName, setFirstName] = useState(mv("first_name"));
  const [lastName, setLastName] = useState(mv("last_name"));
  const [email, setEmail] = useState(client.email || "");
  const [phone, setPhone] = useState(client.phone || "");
  const [company, setCompany] = useState(client.company || "");
  const [title, setTitle] = useState(mv("title"));
  // Business
  const [salesRep, setSalesRep] = useState(mv("sales_rep") || client.company || "");
  const [taxId, setTaxId] = useState(mv("tax_id"));
  // Address
  const [address, setAddress] = useState(client.street_address || "");
  const [city, setCity] = useState(client.city || "");
  const [state, setState] = useState(client.state || "");
  const [zip, setZip] = useState(client.zip_code || "");
  const [country, setCountry] = useState(client.country || "");
  // Tags (categories → tags). Parsed as an array in metadata or a comma string.
  const initialTags = (() => {
    const c = meta0.categories;
    if (Array.isArray(c)) return c.join(", ");
    if (client.tags) return client.tags;
    return typeof c === "string" ? c : "";
  })();
  const [tags, setTags] = useState(initialTags);
  const [notes, setNotes] = useState(client.notes || "");
  const [extra, setExtra] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const k of extraKeys) o[k] = String(meta0[k] ?? "");
    return o;
  });
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    setBusy(true);
    try {
      // Promoted fields go back into metadata; extra custom fields preserved.
      const metadata = {
        ...meta0, ...extra,
        first_name: firstName || undefined, last_name: lastName || undefined,
        title: title || undefined, tax_id: taxId || undefined,
        sales_rep: salesRep || undefined,
        categories: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      };
      await api.updateClient(client.id, {
        name, email, phone, company, notes, metadata, tags: tags || null,
        lead_status: client.lead_status, category: client.category,
        street_address: address || null, city: city || null, state: state || null,
        zip_code: zip || null, country: country || null,
        next_follow_up_date: client.next_follow_up_date,
      });
      await api.approveClient(client.id);
      onResolved();
    } finally { setBusy(false); }
  };

  const reject = async () => {
    setBusy(true);
    try { await api.rejectClient(client.id); onResolved(); }
    finally { setBusy(false); }
  };

  const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface border border-line rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-line">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[16px] font-semibold text-ink">New customer to review</h2>
              <span className="text-[10px] font-bold uppercase tracking-wider text-accent bg-accent/10 border border-accent/20 px-2 py-0.5 rounded-full">{sourceLabel(meta0)}</span>
            </div>
            <p className="text-[12px] text-muted mt-0.5">Check the parsed details, edit anything, then approve or reject.</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink transition-colors p-1 -mr-1 -mt-1"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {/* Contact */}
          <div className="space-y-3">
            <div className={sectionCls}>Contact</div>
            <div>
              <label className={labelCls}><User size={12} /> Display name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>First name</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputCls} /></div>
              <div><label className={labelCls}>Last name</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputCls} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}><Mail size={12} /> Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} /></div>
              <div><label className={labelCls}><Phone size={12} /> Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}><Building2 size={12} /> Company</label><input value={company} onChange={(e) => setCompany(e.target.value)} className={inputCls} /></div>
              <div><label className={labelCls}>Title</label><input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} /></div>
            </div>
          </div>

          {/* Business */}
          <div className="space-y-3 pt-1">
            <div className={sectionCls}>Business</div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}><UserCog size={12} /> Sales rep</label><input value={salesRep} onChange={(e) => setSalesRep(e.target.value)} className={inputCls} placeholder={company || "Company"} /></div>
              <div><label className={labelCls}><BadgeCheck size={12} /> Tax ID</label><input value={taxId} onChange={(e) => setTaxId(e.target.value)} className={inputCls} /></div>
            </div>
          </div>

          {/* Address */}
          <div className="space-y-3 pt-1">
            <div className={sectionCls}>Address</div>
            <div><label className={labelCls}><MapPin size={12} /> Street</label><input value={address} onChange={(e) => setAddress(e.target.value)} className={inputCls} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>City</label><input value={city} onChange={(e) => setCity(e.target.value)} className={inputCls} /></div>
              <div><label className={labelCls}>State / region</label><input value={state} onChange={(e) => setState(e.target.value)} className={inputCls} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>ZIP / postcode</label><input value={zip} onChange={(e) => setZip(e.target.value)} className={inputCls} /></div>
              <div><label className={labelCls}>Country</label><input value={country} onChange={(e) => setCountry(e.target.value)} className={inputCls} /></div>
            </div>
          </div>

          {/* Categories → tags */}
          <div className="space-y-2 pt-1">
            <div className={sectionCls}><span className="inline-flex items-center gap-1.5"><Tag size={12} /> Categories</span></div>
            <input value={tags} onChange={(e) => setTags(e.target.value)} className={inputCls} placeholder="Comma-separated, e.g. Wholesale, Electronics" />
            {tagList.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tagList.map((t) => <span key={t} className="text-[11px] font-medium text-accent bg-accent/10 border border-accent/20 px-2 py-0.5 rounded-full">{t}</span>)}
              </div>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className={labelCls}><FileText size={12} /> Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              className="w-full bg-surface-2 border border-line rounded-lg px-2.5 py-2 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors resize-none" />
          </div>

          {/* Everything else the form submitted */}
          {extraKeys.length > 0 && (
            <div className="pt-1">
              <div className={`${sectionCls} mb-2`}>Extra details</div>
              <div className="space-y-2.5">
                {extraKeys.map((k) => (
                  <div key={k}>
                    <label className="block text-[11px] font-medium text-muted mb-1 capitalize">{k.replace(/[_-]/g, " ")}</label>
                    <input value={extra[k]} onChange={(e) => setExtra({ ...extra, [k]: e.target.value })} className="w-full bg-surface-2 border border-line rounded-lg h-9 px-2.5 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {meta0.source && (
            <div className="text-[11px] text-muted pt-1">
              Came in via <span className="text-ink-2 font-medium">{sourceLabel(meta0)}</span>
              {meta0.lead_source ? <> · lead source: <span className="text-ink-2">{String(meta0.lead_source)}</span></> : null}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-line">
          <button onClick={reject} disabled={busy}
            className="flex items-center gap-1.5 px-4 h-9 rounded-lg border border-danger text-danger-ink text-[13px] font-medium hover:bg-danger-bg disabled:opacity-50 transition-colors">
            <Ban size={15} /> Reject
          </button>
          <button onClick={approve} disabled={busy || !name.trim()}
            className="flex items-center gap-1.5 px-5 h-9 rounded-lg bg-accent text-on-accent text-[13px] font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity">
            <Check size={15} /> Approve customer
          </button>
        </div>
      </div>
    </div>
  );
}
