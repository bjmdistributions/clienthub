import { ArrowLeft, ExternalLink, Cloud, KeyRound, ShieldCheck, ListChecks, Copy } from "lucide-react";
import { api } from "../lib/api";

// A visual, on-brand walkthrough for creating Google OAuth desktop credentials.
// Illustrations are stylized mock UI blocks (NOT real screenshots).

function MockWindow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 h-6 border-b border-line bg-surface">
        <span className="w-1.5 h-1.5 rounded-full bg-line-3" />
        <span className="w-1.5 h-1.5 rounded-full bg-line-3" />
        <span className="w-1.5 h-1.5 rounded-full bg-line-3" />
        <span className="ml-1.5 text-[9px] text-faint truncate">{title}</span>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function Step({ n, icon: Icon, title, children, mock, last }: {
  n: number; icon: typeof Cloud; title: string; children: React.ReactNode; mock: React.ReactNode; last?: boolean;
}) {
  return (
    <div className="flex gap-3.5">
      <div className="flex flex-col items-center">
        <span className="flex-shrink-0 w-7 h-7 rounded-full bg-accent text-on-accent text-[13px] font-bold flex items-center justify-center">{n}</span>
        {!last && <div className="w-px flex-1 bg-line-2 my-1.5" />}
      </div>
      <div className={`flex-1 grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-3 items-start ${last ? "" : "pb-5"}`}>
        <div>
          <div className="flex items-center gap-1.5 text-[13.5px] font-semibold text-ink mb-1.5">
            <Icon size={14} className="text-accent" /> {title}
          </div>
          <div className="text-[12px] text-muted leading-relaxed">{children}</div>
        </div>
        <div className="sm:pt-0.5">{mock}</div>
      </div>
    </div>
  );
}

export function GoogleCloudGuide({ onBack }: { onBack: () => void }) {
  return (
    <div className="bg-surface border border-line rounded-xl p-6 max-w-2xl">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink mb-4 transition-colors">
        <ArrowLeft size={14} /> Back to email settings
      </button>

      <div className="flex items-center gap-2 mb-1">
        <Cloud size={16} className="text-accent" />
        <h3 className="text-[16px] font-bold text-ink">Get your Google credentials</h3>
      </div>
      <p className="text-[12.5px] text-muted mb-5 leading-relaxed">
        A one-time setup in Google Cloud gives Ecliptr a Client ID + Secret so it can send and read mail on your behalf — without ever storing your Google password. Takes about 5 minutes.
      </p>

      <div className="mb-5">
        <button onClick={() => api.openExternal("https://console.cloud.google.com/")}
          className="inline-flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-on-accent px-4 h-9 rounded-lg text-[13px] font-medium transition-colors">
          Open Google Cloud Console <ExternalLink size={13} />
        </button>
      </div>

      <div>
        <Step n={1} icon={Cloud} title="Create a project"
          mock={
            <MockWindow title="console.cloud.google.com">
              <div className="text-[9px] text-faint mb-1.5">Select a project ▾</div>
              <div className="h-6 rounded border border-dashed border-line-3 flex items-center justify-center text-[10px] text-accent font-medium">+ New Project</div>
            </MockWindow>
          }>
          At the top of the console, open the project picker and create a new project (e.g. "Ecliptr Mail"). Select it once created.
        </Step>

        <Step n={2} icon={ListChecks} title="Enable the Gmail API"
          mock={
            <MockWindow title="APIs &amp; Services · Library">
              <div className="h-5 rounded bg-surface border border-line mb-1.5 flex items-center px-1.5 text-[9px] text-faint">🔍 Gmail API</div>
              <div className="h-6 rounded bg-accent/90 flex items-center justify-center text-[10px] text-on-accent font-semibold">Enable</div>
            </MockWindow>
          }>
          Go to <span className="text-ink-2">APIs &amp; Services → Library</span>, search <span className="text-ink-2 font-medium">Gmail API</span>, and click <span className="text-ink-2">Enable</span>.
        </Step>

        <Step n={3} icon={ShieldCheck} title="Configure the consent screen"
          mock={
            <MockWindow title="OAuth consent screen">
              <div className="flex items-center gap-1.5 mb-1.5"><span className="w-2.5 h-2.5 rounded-full border-2 border-accent" /><span className="text-[9px] text-ink-2">External</span></div>
              <div className="text-[9px] text-faint mb-1">Test users</div>
              <div className="h-5 rounded bg-surface border border-line flex items-center px-1.5 text-[9px] text-success-ink">+ you@gmail.com</div>
            </MockWindow>
          }>
          Under <span className="text-ink-2">OAuth consent screen</span>, choose <span className="text-ink-2 font-medium">External</span>. On the "Test users" step, <span className="text-ink-2 font-medium">add your own Google address</span> — this keeps the app in testing mode (no Google review needed) and lets you authorize it.
        </Step>

        <Step n={4} icon={KeyRound} title="Create OAuth credentials"
          mock={
            <MockWindow title="Credentials · OAuth client ID">
              <div className="text-[9px] text-faint mb-1">Application type</div>
              <div className="h-6 rounded border border-accent bg-accent/10 flex items-center px-2 text-[10px] text-accent font-semibold">Desktop app ▾</div>
              <div className="h-5 mt-1.5 rounded bg-accent/90 flex items-center justify-center text-[9px] text-on-accent font-semibold">Create</div>
            </MockWindow>
          }>
          Go to <span className="text-ink-2">Credentials → Create credentials → OAuth client ID</span>. For <span className="text-ink-2">Application type</span> pick <span className="text-ink-2 font-medium">Desktop app</span> (important — this enables the local loopback flow Ecliptr uses).
        </Step>

        <Step n={5} icon={Copy} title="Copy the ID + secret into Ecliptr" last
          mock={
            <MockWindow title="OAuth client created">
              <div className="text-[9px] text-faint">Client ID</div>
              <div className="h-4 rounded bg-surface border border-line mb-1.5" />
              <div className="text-[9px] text-faint">Client secret</div>
              <div className="h-4 rounded bg-surface border border-line" />
            </MockWindow>
          }>
          Google shows your <span className="text-ink-2 font-medium">Client ID</span> and <span className="text-ink-2 font-medium">Client secret</span>. Paste both back into the Connect Google panel, then click <span className="text-ink-2">Connect</span> — your browser opens once to approve access.
        </Step>
      </div>

      <div className="mt-5 flex items-start gap-2 text-[11.5px] text-muted bg-surface-2/60 border border-line-2 rounded-lg px-3.5 py-2.5 leading-relaxed">
        <ShieldCheck size={14} className="text-success-ink flex-shrink-0 mt-0.5" />
        <span>Ecliptr stores the ID, secret, and Google token in your OS keychain — never your password, never synced to the cloud. You can revoke access anytime from your Google account's security settings.</span>
      </div>
    </div>
  );
}
