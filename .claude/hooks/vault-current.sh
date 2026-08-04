#!/usr/bin/env bash
# Stop hook: if code moved today but the project brain did not, say so.
#
# Directive 1 — state must carry forward. Behaviour changed with no matching
# note means the vault is now lying, and a stale note quoted confidently has
# already caused real errors here.
#
# Deliberately a visible reminder, not a block: blocking Stop can trap a
# session in a loop, and the judgement of which note to update is not
# something a shell script can make.

VAULT="C:/Users/Jack/Documents/Obsidian Vault"
TODAY=$(date +%Y-%m-%d)

changed=""
for repo in "C:/Users/Jack/Desktop/BUSINESS APP" "C:/Users/Jack/Desktop/clienthub-api"; do
  [ -d "$repo/.git" ] || continue
  n=$(git -C "$repo" log --since="$TODAY 00:00" --oneline 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] 2>/dev/null && changed="$changed $(basename "$repo"):$n"
done

[ -z "$changed" ] && exit 0
[ -d "$VAULT/.git" ] || exit 0

vault_today=$(git -C "$VAULT" log --since="$TODAY 00:00" --oneline 2>/dev/null | wc -l | tr -d ' ')
[ "$vault_today" -gt 0 ] 2>/dev/null && exit 0

printf '{"systemMessage":"Code was committed today (%s) but the Obsidian project brain has no change today. Before this task is done: update the note matching what changed and bump its updated/verified dates, add any new note to 00-INDEX, and record load-bearing decisions in decisions/."}\n' "$(echo "$changed" | sed 's/^ //')"
exit 0
