#!/usr/bin/env bash
# PreToolUse guard: refuse shell commands that destroy data.
#
# This is the ENFORCEMENT layer of the never-erase rule. It is executed by the
# Claude Code harness, not by the model, so it holds even if an agent decides
# the command is fine. Documentation asks; this refuses.
#
# Exemptions exist on purpose: a guard annoying enough to be switched off
# protects nothing, so rebuildable directories (node_modules, build output,
# scratch) are allowed through to the normal permission flow.

payload=$(cat)
cmd=$(printf '%s' "$payload" | tr '\n\r\t' '   ')

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED by the never-erase rule (%s). Data is not deleted from this project by an agent. If this is genuinely needed, run it yourself in your own terminal, or remove the rule from .claude/settings.json first."}}\n' "$1"
  exit 0
}

ask() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Touches live production (%s). Confirm the dependency check was done: which routes, webhooks, or configs does this overwrite, and is the current version backed up?"}}\n' "$1"
  exit 0
}

has() { printf '%s' "$cmd" | grep -Eiq "$1"; }

# --- Exempt: rebuildable, contains no business data ------------------------
if has 'node_modules|[/\\]target[/\\]|[/\\]dist[/\\]|scratchpad|AppData[/\\]Local[/\\]Temp|\.next|__pycache__'; then
  exit 0
fi

# --- Recursive force delete ------------------------------------------------
has '\brm\b[^|;&]*-[a-zA-Z]*r[a-zA-Z]*f'            && deny "recursive force delete"
has '\brm\b[^|;&]*-[a-zA-Z]*f[a-zA-Z]*r'            && deny "recursive force delete"
has '\brm\b[^|;&]*(-r[[:space:]]+-f|-f[[:space:]]+-r)' && deny "recursive force delete"
has '\bfind\b[^|;&]*(-delete|-exec[[:space:]]+rm)'  && deny "find -delete"
has '\bshred\b|\bmkfs|\bdd\b[^|;&]*of='             && deny "disk-level destruction"
has 'Remove-Item[^|;&]*-Recurse'                    && deny "Remove-Item -Recurse"
has '\brmdir\b[^|;&]*/s|\bdel\b[^|;&]*/[sq]'        && deny "recursive Windows delete"

# --- Git history / working-tree destruction --------------------------------
has 'git[^|;&]*reset[^|;&]*--hard'                  && deny "git reset --hard discards uncommitted work"
has 'git[^|;&]*clean[^|;&]*-[a-zA-Z]*f'             && deny "git clean deletes untracked files"
has 'git[^|;&]*push[^|;&]*(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$))' && deny "force push rewrites published history"
has 'git[^|;&]*(checkout|restore)[[:space:]]+(--[[:space:]]+)?\.([[:space:]"\x27]|$)' && deny "discards all local changes"
has 'git[^|;&]*branch[^|;&]*[[:space:]]-D'          && deny "force branch delete"
has 'git[^|;&]*tag[^|;&]*-d'                        && deny "deleting a release tag"

# --- Database destruction (only when a DB client is actually invoked) ------
if has '\bsqlite3\b|\bpsql\b|\bmysql\b'; then
  has 'drop[[:space:]]+(table|database|index|view)' && deny "DROP against a live database"
  has 'truncate[[:space:]]+table'                   && deny "TRUNCATE against a live database"
  has 'delete[[:space:]]+from'                      && deny "DELETE FROM against a live database"
  has 'update[^|;&]*set[^|;&]*(null|\x27\x27)'      && deny "bulk NULL/blank overwrite"
fi

# --- The databases and the vault themselves --------------------------------
has '(\brm\b|\bmv\b|\bdel\b|Remove-Item|Clear-Content)[^|;&]*\.db([[:space:]]|$|["\x27])' && deny "moving or deleting a SQLite database"
has '>[[:space:]]*[^[:space:]|;&]*\.db([[:space:]]|$)'  && deny "truncating a SQLite database"
has '(\brm\b|\bmv\b|\bdel\b|Remove-Item|\brmdir\b)[^|;&]*Obsidian' && deny "deleting from the Obsidian project brain"

# --- Production infrastructure ---------------------------------------------
# plaid.rs must never reach the droplet: deploying it activates a THIRD source
# of bank_txn rows on top of the two that already caused the duplicate
# epidemic. This one is absolute — see runbooks/deploy.md.
has '(scp|rsync)[^|;&]*plaid\.rs'                   && deny "deploying plaid.rs would activate a third bank_txn source"

# Everything else that touches the live droplet is allowed but never silent.
has '(scp|rsync)[^|;&]*(161\.35\.106\.143|ecliptr@|root@)' && ask "overwrites files on the live droplet"
has 'systemctl[^|;&]*(stop|disable|mask)[^|;&]*ecliptr'    && ask "stops or disables the live API"
has '(nginx|caddy|systemd|\.service|\.env|Caddyfile)[^|;&]*(>|scp|rsync|tee)' && ask "rewrites a production config"

exit 0
