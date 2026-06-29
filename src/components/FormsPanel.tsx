import { useEffect, useState } from "react";
import { api, type FormDef, type FormField } from "../lib/api";

const FIELD_TYPES: [string, string][] = [
  ["name", "Name"], ["email", "Email"], ["phone", "Phone"], ["company", "Company"],
  ["text", "Short text"], ["textarea", "Long text"], ["select", "Dropdown"],
  ["checkbox", "Checkbox"], ["date", "Date"],
];
const uid = () => Math.random().toString(36).slice(2, 9);
type Draft = FormDef & { fields: FormField[] };

const inp = "w-full bg-surface-2 border border-line rounded-lg h-9 px-3 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

function blankForm(): Draft {
  return {
    id: "", name: "", title: "Get in touch", intro: "", fields_json: "[]",
    active: true, created_at: "", updated_at: "",
    fields: [
      { id: uid(), type: "name", label: "Full name", required: true },
      { id: uid(), type: "email", label: "Email", required: true },
      { id: uid(), type: "phone", label: "Phone", required: false },
    ],
  };
}

export function FormsPanel() {
  const [forms, setForms] = useState<FormDef[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [copied, setCopied] = useState("");
  const [mapFields, setMapFields] = useState<{ value: string; label: string }[]>([]);

  const load = () => api.listForms().then(setForms).catch(() => {});
  useEffect(() => { load(); }, []);
  useEffect(() => { api.getIntakeFields().then((fs) => setMapFields(fs.filter((f) => f.value !== "ignore"))).catch(() => {}); }, []);

  const openEdit = (f: FormDef) => {
    let fields: FormField[] = [];
    try { fields = JSON.parse(f.fields_json || "[]"); } catch { /* ignore */ }
    setEditing({ ...f, fields });
  };
  const save = async () => {
    if (!editing) return;
    await api.saveForm({
      id: editing.id || undefined,
      name: editing.name || editing.title || "Untitled form",
      title: editing.title, intro: editing.intro,
      fields_json: JSON.stringify(editing.fields), active: editing.active,
    }).catch(() => {});
    setEditing(null); load();
  };
  const remove = async (id: string) => { if (!confirm("Delete this form?")) return; await api.deleteForm(id).catch(() => {}); load(); };
  const copy = (id: string) => { navigator.clipboard.writeText(`https://ecliptr.app/f/${id}`).catch(() => {}); setCopied(id); setTimeout(() => setCopied(""), 1500); };

  const setField = (i: number, patch: Partial<FormField>) =>
    setEditing((e) => e ? { ...e, fields: e.fields.map((f, idx) => idx === i ? { ...f, ...patch } : f) } : e);
  const addField = () =>
    setEditing((e) => e ? { ...e, fields: [...e.fields, { id: uid(), type: "text", label: "New field", required: false }] } : e);
  const removeField = (i: number) =>
    setEditing((e) => e ? { ...e, fields: e.fields.filter((_, idx) => idx !== i) } : e);
  const reorder = (from: number, to: number) =>
    setEditing((e) => {
      if (!e || from === to) return e;
      const fs = [...e.fields]; const [m] = fs.splice(from, 1); fs.splice(to, 0, m); return { ...e, fields: fs };
    });

  if (editing) {
    return (
      <div className="max-w-2xl">
        <div className="flex justify-between items-center mb-4">
          <button onClick={() => setEditing(null)} className="text-[13px] text-muted hover:text-ink">← Back</button>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[12px] text-ink-2"><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active</label>
            <button onClick={save} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium">Save form</button>
          </div>
        </div>
        <div className="space-y-3 bg-surface border border-line rounded-xl p-4">
          <div><label className="block text-[10px] uppercase tracking-wide text-muted mb-1">Form name (internal)</label><input className={inp} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. Website lead form" /></div>
          <div><label className="block text-[10px] uppercase tracking-wide text-muted mb-1">Public title</label><input className={inp} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></div>
          <div><label className="block text-[10px] uppercase tracking-wide text-muted mb-1">Intro (optional)</label><textarea className={inp + " h-auto py-2"} rows={2} value={editing.intro} onChange={(e) => setEditing({ ...editing, intro: e.target.value })} /></div>
        </div>

        <div className="text-[10px] uppercase tracking-wide text-muted mt-5 mb-2">Fields — drag ⠿ to reorder</div>
        <div className="space-y-2">
          {editing.fields.map((f, i) => (
            <div key={f.id} draggable onDragStart={() => setDragIdx(i)} onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragIdx !== null) reorder(dragIdx, i); setDragIdx(null); }}
              className="bg-surface border border-line rounded-lg p-3">
              <div className="flex items-center gap-2">
                <span className="cursor-grab text-muted text-[15px] select-none" title="Drag to reorder">⠿</span>
                <select value={f.type} onChange={(e) => setField(i, { type: e.target.value })} className="bg-surface-2 border border-line rounded-lg h-8 px-2 text-[12px] text-ink">
                  {FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <input value={f.label} onChange={(e) => setField(i, { label: e.target.value })} placeholder="Label" className="flex-1 bg-surface-2 border border-line rounded-lg h-8 px-2 text-[13px] text-ink" />
                <label className="text-[11px] text-ink-2 flex items-center gap-1"><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> req</label>
                <button onClick={() => removeField(i)} className="text-muted hover:text-red-400 px-1">✕</button>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-[11px] text-muted whitespace-nowrap">Maps to</span>
                <select
                  value={f.map ?? (["name", "email", "phone", "company"].includes(f.type) ? f.type : "")}
                  onChange={(e) => setField(i, { map: e.target.value })}
                  className="flex-1 bg-surface-2 border border-line rounded-lg h-8 px-2 text-[12px] text-ink"
                  title="Which of your client fields this answer fills"
                >
                  <option value="">Store as answer</option>
                  {mapFields.map((mf) => <option key={mf.value} value={mf.value}>{mf.label}</option>)}
                </select>
              </div>
              {f.type === "select" && (
                <input value={(f.options || []).join(", ")} onChange={(e) => setField(i, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                  placeholder="Options, comma-separated" className="mt-2 w-full bg-surface-2 border border-line rounded-lg h-8 px-2 text-[12px] text-ink" />
              )}
            </div>
          ))}
        </div>
        <button onClick={addField} className="mt-2 border border-line text-ink-2 hover:bg-surface-3 px-3 h-8 rounded-lg text-[12px] font-medium">+ Add field</button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex justify-between items-center">
        <div>
          <h4 className="text-[14px] font-semibold text-ink">Lead forms</h4>
          <p className="text-[12px] text-muted">Build a form, share the link — submissions become pending clients. <button onClick={() => api.openExternal("https://ecliptr.app/guide#forms")} className="text-accent hover:underline">Setup guide →</button></p>
        </div>
        <button onClick={() => setEditing(blankForm())} className="bg-accent hover:bg-accent-hover text-white px-4 h-9 rounded-lg text-[13px] font-medium whitespace-nowrap">+ New form</button>
      </div>
      {forms.length === 0 ? (
        <p className="text-muted text-[13px] bg-surface border border-line rounded-xl p-6 text-center">No forms yet.</p>
      ) : forms.map((f) => (
        <div key={f.id} className="bg-surface border border-line rounded-xl p-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-ink truncate">{f.name || f.title}{!f.active && <span className="ml-2 text-[10px] text-muted">(inactive)</span>}</div>
            <div className="text-[11px] text-accent truncate">ecliptr.app/f/{f.id.slice(0, 10)}…</div>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button onClick={() => copy(f.id)} className="border border-line text-ink-2 hover:bg-surface-3 px-3 h-8 rounded-lg text-[12px] font-medium">{copied === f.id ? "Copied ✓" : "Copy link"}</button>
            <button onClick={() => openEdit(f)} className="border border-line text-ink-2 hover:bg-surface-3 px-3 h-8 rounded-lg text-[12px] font-medium">Edit</button>
            <button onClick={() => remove(f.id)} className="border border-line text-ink-2 hover:bg-surface-3 px-3 h-8 rounded-lg text-[12px] font-medium">Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}
