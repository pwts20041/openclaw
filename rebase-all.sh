#!/bin/bash
set -e

BRANCHES=(
  "fix/cron-fallback-timeout"
  "fix/acp-gemini-session-load"
  "fix/control-ui-token-display"
  "fix/acp-yield-error-resume"
  "fix/handshake-timeout-configurable"
  "feat/skills-priority-config"
  "fix/skills-truncation-visibility"
  "fix/write-tool-append-mode"
  "fix/agent-loop-stall-notification"
  "feat/subagent-completion-notify"
)

echo "=== Fetching upstream ==="
git fetch upstream

RESULTS=""
for branch in "${BRANCHES[@]}"; do
  echo ""
  echo "=== Rebasing $branch ==="
  git checkout "$branch" 2>/dev/null || { RESULTS+="$branch: SKIP (not found)\n"; continue; }
  
  if git rebase upstream/main; then
    echo "Rebase OK, pushing..."
    git push --force origin "$branch" && {
      RESULTS+="$branch: ✅ rebased + pushed\n"
    } || {
      RESULTS+="$branch: ⚠️ rebased but push failed\n"
    }
  else
    echo "Conflict in $branch, aborting..."
    git rebase --abort
    RESULTS+="$branch: ❌ CONFLICT\n"
  fi
done

# Clean up merged branch
echo ""
echo "=== Cleaning up merged branch ==="
git branch -D fix/subagent-timeout-partial-results 2>/dev/null && echo "Deleted local" || echo "Already gone"
git push origin --delete fix/subagent-timeout-partial-results 2>/dev/null && echo "Deleted remote" || echo "Already gone from remote"

echo ""
echo "========== SUMMARY =========="
echo -e "$RESULTS"
