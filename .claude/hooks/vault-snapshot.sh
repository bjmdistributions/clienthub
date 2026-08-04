#!/usr/bin/env bash
# PostToolUse: snapshot the Obsidian project brain after any write that touched it.
#
# The deny guard stops deletion. This makes overwriting recoverable: every
# version of every note is committed, so a note that gets clobbered by a bad
# edit can always be recovered with `git log -p` in the vault.

VAULT="C:/Users/Jack/Documents/Obsidian Vault"

payload=$(cat)
printf '%s' "$payload" | grep -qi 'Obsidian' || exit 0
[ -d "$VAULT/.git" ] || exit 0

cd "$VAULT" || exit 0
git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain)" ] && exit 0

git add -A >/dev/null 2>&1
git commit -q -m "vault: auto-snapshot after agent edit" >/dev/null 2>&1
exit 0
