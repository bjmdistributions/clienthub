import { useEffect, useState } from "react";
import { Check, AlertCircle } from "lucide-react";

// Minimal app-wide toast — replaces native alert() dialogs. Fire-and-forget:
// call toast("Exported 12 deals") from anywhere; ToastHost (mounted once in
// App) renders the stack bottom-right in the same style the views already use.
export type ToastKind = "success" | "error";

let seq = 0;

/** Show an in-app toast. Errors stay up a little longer. */
export function toast(message: string, kind: ToastKind = "success") {
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { id: ++seq, message: String(message), kind } }));
}

export function ToastHost() {
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: ToastKind }[]>([]);

  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as { id: number; message: string; kind: ToastKind };
      setToasts((t) => [...t, d]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== d.id)), d.kind === "error" ? 5000 : 3000);
    };
    window.addEventListener("app-toast", h);
    return () => window.removeEventListener("app-toast", h);
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-5 right-5 z-[90] flex flex-col items-end gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id}
          className="bg-ink text-surface px-4 py-2.5 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.18)] text-[13px] flex items-center gap-2 animate-fade-in max-w-[380px] pointer-events-auto">
          {t.kind === "error"
            ? <AlertCircle size={13} className="text-danger-ink flex-shrink-0" />
            : <Check size={13} className="text-success-ink flex-shrink-0" />}
          <span className="min-w-0 break-words">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
