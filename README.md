# ClientHub

Local-first desktop app for client management, AI-assisted email, and PDF invoicing. Cross-platform (macOS + Windows) via Tauri 2. P2P sync via Syncthing. AI via local Ollama. Email via SMTP/IMAP.

## For agents working on this codebase

**Read in this exact order before doing anything:**

1. **[AGENT-PROTOCOL.md](./AGENT-PROTOCOL.md)** — How to work on this codebase without drifting. Plan-first execution rules, when to ask vs proceed, verification gates.
2. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — System design. Read this before changing any module so you understand the contracts.
3. **[TASKS.md](./TASKS.md)** — The remaining work, decomposed into atomic units with acceptance criteria. **Pick tasks from here. Do not invent tasks.**
4. **[DEPLOY.md](./DEPLOY.md)** — How the human ships builds. Reference only; agents do not run deploys.

## For the human (project owner)

- **What's built:** ~95% of the application. Backend (sync engine, IMAP scanner, PDF generator, AI integration, CSV import, signup rules) and frontend (6-tab settings, dashboard, clients with detail view, invoices with AI assist, email inbox + compose) are done.
- **What's left:** mostly polish — icons, OAuth consent flow, drafts review UI, code-signing setup. All catalogued in `TASKS.md`.
- **How to ship:** `DEPLOY.md` has the step-by-step. GitHub Actions builds both `.dmg` and `.msi` automatically.

## Quick start (development)

```bash
# One-time setup
npm install
ollama pull llama3.1:8b   # in another terminal: ollama serve

# Run
cargo tauri dev
```

Stack: Tauri 2 + Rust + React 18 + TypeScript + Tailwind + SQLite + Ollama.
