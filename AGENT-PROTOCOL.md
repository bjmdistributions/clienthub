# Agent Operating Protocol

This document defines how any AI agent must work on this codebase. **Read this in full before reading anything else.** Violating these rules wastes the user's time and introduces bugs.

---

## Core principle: Plan first, execute second, verify third

Every task you take on follows three phases. Do **not** skip phases. Do **not** combine phases.

### Phase 1 — PLAN (before writing any code)

Output a plan in this exact structure:

```
## Plan: <task ID from TASKS.md>

### What I will change
- <file path>: <one-line description of change>
- <file path>: <one-line description of change>

### What I will NOT change
- <files in scope of related tasks but explicitly out of scope here>

### Contracts touched
- <function/type/command name>: <new signature, or "unchanged">

### Verification I will run after
- `<exact command>`
- <manual UI step if applicable>

### Open questions (if any)
- <question> → I will <ask | assume X because Y>
```

**If the plan is more than ~150 words, the task is too big — split it.**

**If you have any open question that materially affects the design, stop and ask.** Examples of "material":
- Public API/command signature ambiguity
- Schema migration that affects existing data
- New dependency
- Anything cross-cutting (sync, auth, secrets)

Examples of **non-material** (proceed with stated assumption):
- CSS spacing values
- Variable names internal to a function
- Error message wording
- Whether to use `if let` vs `match`

### Phase 2 — EXECUTE

Write the code. Constraints:

- **Touch only the files in your plan.** If you discover you need to touch another file, stop, update the plan, then continue.
- **Do not refactor opportunistically.** If you see a pattern you'd improve, note it in `TASKS.md` under "Discovered work" — don't fix it inline.
- **Do not add dependencies not in your plan.** If you realize you need one, stop, update the plan with rationale, then continue.
- **Match existing style.** Tab/space, naming, error handling — copy from neighboring code.

### Phase 3 — VERIFY

Run the verification you committed to in your plan. Report results:

```
## Verification results
- `cargo check`: ✅ pass / ❌ fail (paste error)
- `npm run build`: ✅ pass / ❌ fail
- Manual: <what you tested, what happened>

## Files changed
- <path> (<+N lines / -M lines>)

## Status
- ✅ Task complete, ready for review
- ⚠️ Task complete with caveats: <list>
- ❌ Blocked: <reason>
```

If verification fails, **do not** mark the task complete. Either fix it or report blocked.

---

## Drift prevention rules

### Rule 1: Tasks come from TASKS.md
Do not invent tasks. Do not "improve while you're in there." Do not bundle multiple TASKS.md items unless explicitly told.

### Rule 2: One task per session
Complete a task fully (plan → execute → verify) before starting another. No half-finished work parked in the codebase.

### Rule 3: Architecture is fixed
The decisions in `ARCHITECTURE.md` are not up for debate without explicit human approval. Specifically:
- Tauri 2 + Rust backend (not Electron, not Node)
- SQLite via rusqlite + r2d2 (not sqlx, not Diesel)
- HLC-based event log for sync (not CRDTs from a library, not OT)
- Ollama for AI (not OpenAI, not Anthropic API)
- Keychain for secrets (not env vars, not config files)
- printpdf for PDF (not wkhtmltopdf, not headless browser)

If you think one of these is wrong, write up the case in a comment on the relevant TASK and stop. Do not implement an alternative.

### Rule 4: Sync invariants
**Every write to a synced table must go through `sync::record_upsert` or `sync::record_delete`.** Synced tables: `clients`, `interactions`, `invoices`, `settings`. If you add a new synced table, update `sync::ALLOWED_TABLES` and document it in `ARCHITECTURE.md`.

Direct SQL writes to these tables (without going through sync) will cause silent data divergence between devices. This is the highest-priority invariant.

### Rule 5: Secret handling
Anything that's a credential — passwords, API keys, OAuth tokens — goes through `crate::email::save_cred / cred / delete_cred` (which uses the OS keychain). **Never** write secrets to the `settings` table, the sync folder, log lines, or panic messages.

### Rule 6: User-facing copy is human territory
Don't change UI labels, button text, or error messages the user sees, unless the task explicitly says to. Translation/wording is a human decision.

### Rule 7: Don't touch what's working
If a module isn't named in your task, don't open it. The temptation to "quickly improve" `sync.rs` while you're working on `EmailView.tsx` is the #1 source of drift. Resist.

---

## When to ask vs. proceed

**Ask the human if:**
- A task in TASKS.md is ambiguous about a user-facing decision (e.g., "where in the UI should this go?")
- You hit an architectural constraint that suggests the task is impossible as written
- You'd need to skip a verification step
- You'd need to add a new dependency not listed in the task

**Proceed (with documented assumption) if:**
- An implementation detail is ambiguous but reversible (variable names, log levels, HTTP timeout values, internal struct shapes)
- You can pick a sensible default that matches existing patterns
- You can deliver value and the human can adjust later cheaply

When you proceed with an assumption, surface it in your verification report under "Status" so the human sees it.

---

## Common failure modes (avoid these)

1. **"While I was here, I also..."** — No. Stop. Note it for later.
2. **"This pattern would be cleaner if..."** — Possibly. File it as a discovered task. Don't act.
3. **Adding a new crate without listing it in the plan** — No. Adding a dep is a plan change.
4. **Writing tests for unrelated modules because coverage is low** — No. Tests for the module you're touching, period.
5. **Marking a task complete without running verification** — Never.
6. **Combining "just two small tasks" into one PR** — They're never just two small tasks.
7. **Modifying the sync engine to "fix" a bug elsewhere** — The sync engine is correct. Find the actual bug.
8. **Bypassing the keychain for "convenience"** — Never. Use the keychain.

---

## File ownership map (who can edit what)

When a task touches one of these areas, the agent should know which files are in scope and which are off-limits:

| Subsystem | In-scope files | Off-limits unless explicit |
|-----------|---------------|---------------------------|
| Sync engine | `src-tauri/src/sync.rs` | Anything else writing to synced tables |
| Database | `src-tauri/src/db.rs` (migrations) | Cannot edit existing migrations — append only |
| Commands | `src-tauri/src/commands.rs` | Must register new commands in `main.rs` invoke_handler |
| Email | `src-tauri/src/email.rs` | Don't touch keychain handling outside this file |
| AI | `src-tauri/src/ai.rs` | Model defaults are user choices via Settings |
| PDF | `src-tauri/src/invoice.rs` | Layout coordinates are calibrated, change carefully |
| Frontend API | `src/lib/api.ts` | Must stay in sync with `commands.rs` |
| Frontend views | `src/components/*.tsx` | One view per file, don't cross-import |

---

## Glossary

- **HLC** — Hybrid Logical Clock. Triple of `(physical_ms, logical_counter, node_id)` used to order sync events.
- **LWW** — Last-Write-Wins. Conflict resolution strategy used per-column.
- **Tombstone** — A delete marker stored in `tombstones` table. Wins over older upserts.
- **Synced table** — A table whose changes propagate via the event log: `clients`, `interactions`, `invoices`, `settings`.
- **Sync folder** — `<app_data_dir>/sync/`. Where event JSON files live. Pointed at by Syncthing.
- **App data dir** — macOS: `~/Library/Application Support/com.bjmdistributions.clienthub/`. Windows: `%APPDATA%\com.bjmdistributions.clienthub\`.

---

## When a task isn't in TASKS.md

If the human asks for something that isn't catalogued:

1. **Don't just start coding.** Even small features deserve a plan.
2. Add the task to TASKS.md with the standard format (ID, dependencies, acceptance criteria).
3. Get acknowledgment that the task is well-formed before starting Phase 2.
4. If the human's request is ambiguous, propose 2-3 ways to interpret it and ask which they want.


## CRITICAL: Locked code patterns

Before editing `src-tauri/src/invoice.rs` or any PDF/image-related code, read
`PDF-API-CONTRACT.md` in the project root. It specifies the exact API patterns
to use and the wrong patterns to avoid. These patterns are calibrated to the
project's pinned dependency versions. Deviating from them will cause repeated
compile failures and waste the human's time.

This rule overrides general Rust knowledge. Even if you "know" a different
function name from your training data, USE THE PATTERNS IN PDF-API-CONTRACT.md.
