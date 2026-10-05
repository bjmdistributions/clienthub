// R-441 company documents: the desktop's calls (src-tauri/src/company_docs.rs).
import { invoke } from "@tauri-apps/api/core";

export interface DocVersion {
  version: number;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  note: string;
  created_by: string;
  created_at: string;
}

export interface CompanyDoc {
  id: string;
  title: string;
  category: string;
  checklist_key: string;
  expires_on: string;
  notes: string;
  current_version: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
  versions: DocVersion[];
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const docsApi = {
  list: () => invoke<{ documents: CompanyDoc[] }>("docs_list").then((r) => r.documents || []),
  upload: (a: { title: string; category: string; checklistKey: string; filename: string; bytes: Uint8Array }) =>
    invoke<{ id: string }>("docs_upload", {
      title: a.title, category: a.category, checklistKey: a.checklistKey, filename: a.filename, bytesB64: toB64(a.bytes),
    }),
  update: (id: string, patch: Partial<Pick<CompanyDoc, "title" | "category" | "checklist_key" | "expires_on" | "notes">>) =>
    invoke("docs_update", { id, patch }),
  newVersion: (id: string, bytes: Uint8Array, note: string) =>
    invoke<{ version: number }>("docs_new_version", { id, filename: null, note, bytesB64: toB64(bytes) }),
  archive: (id: string, archived: boolean) => invoke("docs_archive", { id, archived }),
  file: (id: string, version?: number) => invoke<string>("docs_file", { id, version: version ?? null }).then(fromB64),
  saveAs: (id: string, version: number, dest: string) => invoke("docs_save_as", { id, version, dest }),
  signature: () => invoke<{ png: string | null }>("docs_signature_get").then((r) => r.png),
  saveSignature: (png: string) => invoke("docs_signature_put", { png }),
  mirror: () => invoke<{ folder: string; copied: number }>("docs_mirror"),
  openFolder: () => invoke("docs_open_folder"),
};
