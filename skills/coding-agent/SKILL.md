---
name: coding-agent
description: 'Delegate coding tasks to Codex, Claude Code, OpenCode, or Pi agents via foreground bash for quick one-shot commands and sessions_spawn + sessions_yield for longer runs. Use when: (1) building/creating new features or apps, (2) reviewing PRs (spawn in temp dir), (3) refactoring large codebases, (4) iterative coding that needs file exploration. NOT for: simple one-liner fixes (just edit), reading code (use read tool), thread-bound ACP harness requests in chat (for example spawn/run Codex or Claude Code in a Discord thread; use sessions_spawn with runtime:"acp"), or any work in ~/clawd workspace (never spawn agents here). Claude Code: use --print --permission-mode bypassPermissions (no PTY). Codex/Pi/OpenCode: pty:true required.'
metadata:
  {
    "openclaw": { "emoji": "🧩", "requires": { "anyBins": ["claude", "codex", "opencode", "pi"] } },
  }
---

# Coding Agent (bash-first)

Use **bash** for quick one-shot coding agent work. For longer runs, use `sessions_spawn` + `sessions_yield` so completion comes back to the requester session.

## ⚠️ PTY Mode: Codex/Pi/OpenCode yes, Claude Code no

For **Codex, Pi, and OpenCode**, PTY is still required (interactive terminal apps):

```bash
# ✅ Correct for Codex/Pi/OpenCode
bash pty:true command:"codex exec 'Your prompt'"
```

For **Claude Code** (`claude` CLI), use `--print --permission-mode bypassPermissions` instead.
`--dangerously-skip-permissions` with PTY can exit after the confirmation dialog.
`--print` mode keeps full tool access and avoids interactive confirmation:

```bash
# ✅ Correct for Claude Code (no PTY needed)
cd /path/to/project && claude --permission-mode bypassPermissions --print 'Your task'

# ❌ Wrong for Claude Code
bash pty:true command:"claude --dangerously-skip-permissions 'task'"
```

### Bash Tool Parameters

| Parameter    | Type    | Description                                                                 |
| ------------ | ------- | --------------------------------------------------------------------------- |
| `command`    | string  | The shell command to run                                                    |
| `pty`        | boolean | **Use for coding agents!** Allocates a pseudo-terminal for interactive CLIs |
| `workdir`    | string  | Working directory (agent sees only this folder's context)                   |
| `timeout`    | number  | Timeout in seconds (kills process on expiry)                                |
| `elevated`   | boolean | Run on host instead of sandbox (if allowed)                                 |

### Session Tools (for longer runs)

| Tool             | Description                                                     |
| ---------------- | --------------------------------------------------------------- |
| `sessions_spawn` | Start a long-running coding task and route completion back here |
| `sessions_yield` | Pause this session while the spawned run works and resume later |

For Codex, Claude Code, and OpenCode requests, set `runtime:"acp"` and the matching `agentId`.

---

## Quick Start: One-Shot Tasks

For quick prompts/chats, create a temp git repo and run:

```bash
# Quick chat (Codex needs a git repo!)
SCRATCH=$(mktemp -d) && cd $SCRATCH && git init && codex exec "Your prompt here"

# Or in a real project - with PTY!
bash pty:true workdir:~/Projects/myproject command:"codex exec 'Add error handling to the API calls'"
```

**Why git init?** Codex refuses to run outside a trusted git directory. Creating a temp repo solves this for scratch work.

---

## The Pattern: workdir + pty for one-shots

For quick tasks, run the agent in the target directory with PTY when needed:

```bash
# Quick one-shot in the target directory (with PTY!)
bash pty:true workdir:~/project command:"codex exec --full-auto 'Build a snake game'"
```

**Why workdir matters:** Agent wakes up in a focused directory, doesn't wander off reading unrelated files (like your soul.md 😅). For longer work, switch to `sessions_spawn` + `sessions_yield`.

---

## Codex CLI

**Model:** `gpt-5.2-codex` is the default (set in ~/.codex/config.toml)

### Flags

| Flag            | Effect                                             |
| --------------- | -------------------------------------------------- |
| `exec "prompt"` | One-shot execution, exits when done                |
| `--full-auto`   | Sandboxed but auto-approves in workspace           |
| `--yolo`        | NO sandbox, NO approvals (fastest, most dangerous) |

### Building/Creating

```bash
# Quick one-shot (auto-approves) - remember PTY!
bash pty:true workdir:~/project command:"codex exec --full-auto 'Build a dark mode toggle'"

# Longer work: spawn and yield so completion comes back here
sessions_spawn(task="In /home/user/project, use Codex to refactor the auth module", runtime:"acp", agentId:"codex", cwd:"/home/user/project", mode:"run", label:"auth-refactor", streamTo:"parent")
sessions_yield(message="Waiting for Codex to finish the auth refactor...")
```

### Reviewing PRs

**⚠️ CRITICAL: Never review PRs in OpenClaw's own project folder!**
Clone to temp folder or use git worktree.

```bash
# Clone to temp for safe review
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/user/repo.git $REVIEW_DIR
cd $REVIEW_DIR && gh pr checkout 130
bash pty:true workdir:$REVIEW_DIR command:"codex review --base origin/main"
# Clean up after: trash $REVIEW_DIR

# Or use git worktree (keeps main intact)
git worktree add /tmp/pr-130-review pr-130-branch
bash pty:true workdir:/tmp/pr-130-review command:"codex review --base main"
```

### Batch PR Reviews (parallel army!)

```bash
# Fetch all PR refs first
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'

# Deploy the army - one spawned run per PR
sessions_spawn(task="In /home/user/project, review PR #86 using git diff origin/main...origin/pr/86", runtime:"acp", agentId:"codex", cwd:"/home/user/project", mode:"run", label:"pr-86-review", streamTo:"parent")
sessions_spawn(task="In /home/user/project, review PR #87 using git diff origin/main...origin/pr/87", runtime:"acp", agentId:"codex", cwd:"/home/user/project", mode:"run", label:"pr-87-review", streamTo:"parent")

# Yield until one finishes or asks for input
sessions_yield(message="Waiting for the PR reviews to finish...")

# Post results to GitHub
gh pr comment <PR#> --body "<review content>"
```

---

## Claude Code

```bash
# Foreground
bash workdir:~/project command:"claude --permission-mode bypassPermissions --print 'Your task'"

# Longer work
sessions_spawn(task="In /home/user/project, use Claude Code to handle the requested coding task", runtime:"acp", agentId:"claude", cwd:"/home/user/project", mode:"run", label:"claude-task", streamTo:"parent")
sessions_yield(message="Waiting for Claude Code to finish...")
```

---

## OpenCode

```bash
bash pty:true workdir:~/project command:"opencode run 'Your task'"
```

---

## Pi Coding Agent

```bash
# Install: npm install -g @mariozechner/pi-coding-agent
bash pty:true workdir:~/project command:"pi 'Your task'"

# Non-interactive mode (PTY still recommended)
bash pty:true command:"pi -p 'Summarize src/'"

# Different provider/model
bash pty:true command:"pi --provider openai --model gpt-4o-mini -p 'Your task'"
```

**Note:** Pi now has Anthropic prompt caching enabled (PR #584, merged Jan 2026)!

---

## Parallel Issue Fixing with git worktrees

For fixing multiple issues in parallel, use git worktrees:

```bash
# 1. Create worktrees for each issue
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

# 2. Spawn Codex for each worktree
sessions_spawn(task="In /tmp/issue-78, run pnpm install, fix issue #78: <description>, and commit after review.", runtime:"acp", agentId:"codex", cwd:"/tmp/issue-78", mode:"run", label:"issue-78")
sessions_spawn(task="In /tmp/issue-99, run pnpm install, fix issue #99 from the approved ticket summary, implement only the in-scope edits, and commit after review.", runtime:"acp", agentId:"codex", cwd:"/tmp/issue-99", mode:"run", label:"issue-99")

# 3. Yield until the fixes complete or ask for input
sessions_yield(message="Waiting for the issue fixes to finish...")

# 4. Create PRs after fixes
cd /tmp/issue-78 && git push -u origin fix/issue-78
gh pr create --repo user/repo --head fix/issue-78 --title "fix: ..." --body "..."

# 5. Cleanup
git worktree remove /tmp/issue-78
git worktree remove /tmp/issue-99
```

---

## ⚠️ Rules

1. **Use the right execution mode per agent**:
   - Codex/Pi/OpenCode: `pty:true`
   - Claude Code: `--print --permission-mode bypassPermissions` (no PTY required)
2. **Respect tool choice** - if user asks for Codex, use Codex.
   - Orchestrator mode: do NOT hand-code patches yourself.
   - If an agent fails/hangs, respawn it or ask the user for direction, but don't silently take over.
3. **Be patient** - don't kill sessions because they're "slow"
4. **Monitor with process:log** - check progress without interfering
5. **--full-auto for building** - auto-approves changes
6. **vanilla for reviewing** - no special flags needed
7. **Parallel is OK** - run many Codex processes at once for batch work
8. **NEVER start Codex in ~/.openclaw/** - it'll read your soul docs and get weird ideas about the org chart!
9. **NEVER checkout branches in ~/Projects/openclaw/** - that's the LIVE OpenClaw instance!

---

## Progress Updates (Critical)

When you spawn coding agents with `sessions_spawn`, keep the user in the loop.

- Send 1 short message when you start (what's running + where).
- Then only update again when something changes:
  - a milestone completes (build finished, tests passed)
  - the agent asks a question / needs input
  - you hit an error or need user action
  - the agent finishes (include what changed + where)
- If you cancel a spawned run, immediately say you canceled it and why.

This prevents the user from seeing only "Agent failed before reply" and having no idea what happened.

---

## Recommended: sessions_spawn + sessions_yield

**For long-running tasks, use `sessions_spawn` with `sessions_yield`.**

```bash
# ✅ Recommended: sessions_spawn + sessions_yield
sessions_spawn(task="In /home/user/project, use Codex to build a REST API for todos", runtime:"acp", agentId:"codex", cwd:"/home/user/project", mode:"run", label:"todos-api", streamTo:"parent")
sessions_yield(message="Waiting for Codex to finish the todos API...")

# Result auto-announces back to the requester session
# Agent has full context to take the next action
```

**Why this works:**
- Delivers the result **back to the session that spawned the task**
- Full conversation context is preserved
- The agent can verify the work, execute the next step, or escalate to the user
- No broken notification pipeline

**When to use exec (non-background):**
- Quick one-shot commands that complete immediately
- No need for result notification back to the session

Avoid `exec background` for long-running coding tasks; use `sessions_spawn` + `sessions_yield` instead.

---

## Learnings (Jan 2026)

- **PTY is essential:** Coding agents are interactive terminal apps. Without `pty:true`, output breaks or agent hangs.
- **Git repo required:** Codex won't run outside a git directory. Use `mktemp -d && git init` for scratch work.
- **Foreground exec is your friend:** `codex exec "prompt"` runs and exits cleanly - perfect for one-shots.
- **submit vs write:** Use `submit` to send input + Enter, `write` for raw data without newline.
- **Sass works:** Codex responds well to playful prompts. Asked it to write a haiku about being second fiddle to a space lobster, got: _"Second chair, I code / Space lobster sets the tempo / Keys glow, I follow"_ 🦞
