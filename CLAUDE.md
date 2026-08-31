# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## 5. Project brain (read this before asking the codebase)

This project has a maintained knowledge base in Obsidian:

**`C:/Users/Jack/Documents/Obsidian Vault/Ecliptr/`**

**Start with `00-RULES.md`, then `00-START-HERE.md`, then `00-INDEX.md`.** Those files route you to the right note in one hop. Do not read the whole vault — index first, then open only the 1–2 notes you need.

`00-RULES.md` is binding, not background. Three rules: this file is the working contract; **never erase stored data** (no destruction of business data, vault notes, or git history without a verified backup written first); and **do not break the pipelines** (webhooks, routes, and production configs serve external systems that fail silently — check dependencies first, and keep signature verification, payload handling, and error logging intact through any refactor; see `architecture/public-surface.md`).

Enforced by `.claude/settings.json` deny rules and the `PreToolUse` hook at `.claude/hooks/no-erase.sh`, which refuse the command rather than trusting the agent to comply. Deploys to the droplet and service stops prompt for confirmation; `scp` of `plaid.rs` is refused outright. **Do not weaken the guard to get a task done** — if it blocks you, change approach or ask Jack to run it himself.

`00-RULES.md` also carries the **session-close checklist**: update the note matching what you changed and bump its dates, add any new note's line to `00-INDEX.md`, record load-bearing decisions in `decisions/`, and push anything ugly you left behind to `revisit/` rather than widening the diff.

It holds: how each subsystem actually works and why, a screen-by-screen record of every page and its design choices on both desktop and mobile, the decisions behind the architecture, the landmines in `gotchas.md`, deploy runbooks, and a `revisit/` backlog of known-imperfect code.

**Keep it true.** When you change behaviour, update the matching note in the same session and bump its `updated`/`verified` date. Notes carry a `verified` date because stale figures quoted confidently have already caused real errors here — re-verify before quoting a number. Conventions are in `CONVENTIONS.md`.

**Capture requests.** When Jack describes a feature, add it to `Ecliptr/requests/00-REQUESTS.md` in the same message you acknowledge it — before code, before approval, even if you build it immediately. Nothing he asks for may live only in a chat transcript.

**Work cheaply.** Read `00-START-HERE.md` then `00-INDEX.md`, open only the 1–2 notes it routes you to, and grep before reading code — `commands.rs` (~19.9k lines) and `www/app.js` (~11.2k) must never be read whole. `CONVENTIONS.md` has the full session protocol.
