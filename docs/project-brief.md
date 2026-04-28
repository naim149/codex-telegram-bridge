# Codex Telegram Bridge Project Brief

## Aim

Build or adapt a local Telegram interface that lets a user continue Codex work
without sitting at the host machine. The Telegram bot acts as a remote control
surface for local Codex sessions.

The desired result:

- Start a new Codex session in a chosen project.
- Continue an existing local Codex session or thread.
- Receive Codex progress, questions, command output, diffs, and final answers in
  Telegram.
- Reply to Codex from Telegram where the bridge can observe the input request.
- Change model, reasoning, sandbox, approval, and launch profile settings.
- Keep the setup local and deterministic without adding an extra LLM layer.

## Direction

The bridge should talk directly to Codex through the local CLI, SDK, or app-server
interfaces. Avoid introducing a separate orchestration service unless a future
feature clearly needs it.

The preferred shape:

1. Run a Telegram bot locally.
2. Restrict all Telegram control to an allowlisted set of numeric Telegram user
   IDs.
3. Restrict Codex work to configured project roots.
4. Allow read-only monitoring of configured roots separately from write/control
   access.
5. Stream useful Codex state back to Telegram without flooding the chat.
6. Keep secrets and local Codex state out of source control.

## Token And Budget Behavior

The bridge should not add another LLM layer.

Expected usage:

| Action | Codex budget impact |
|---|---|
| List local sessions | No meaningful Codex usage |
| Select or switch session | No Codex usage |
| Start or continue a Codex turn | Uses Codex budget, same as local Codex |
| Stream output to Telegram | No extra Codex tokens |
| Telegram approval buttons | No extra Codex tokens unless they resume a turn |
| Change model or effort setting | No usage by itself |
| Voice transcription | Extra local or API usage only if enabled |
| File or image input | Uses Codex budget when included in a Codex turn |

## Required User Inputs

Before running a live bot, collect:

- Telegram bot token from `@BotFather`.
- Numeric Telegram allowed user ID or IDs.
- Project root paths the bot may control.
- Optional project root paths the bot may monitor read-only.
- Default workspace for new sessions.
- Default model.
- Default sandbox and approval policy.
- Whether `danger-full-access` style profiles are allowed.
- Whether voice transcription is needed.
- Whether file uploads should be allowed.

Do not commit tokens, chat IDs, session files, local Codex auth files, or `.env`.

## Security Baseline

Minimum requirements:

- `.env` ignored by Git.
- Mandatory Telegram user allowlist.
- Project allowlist for any write/control action.
- Separate monitoring allowlist for passive session visibility.
- Default sandbox should be `workspace-write` or stricter.
- Full access must be opt-in and require confirmation.
- Disable arbitrary shell command endpoints unless specifically needed.
- Never expose local Codex auth files.
- Do not copy Codex sessions or indexes into this repository.
- Do not run multiple writing Codex turns in the same worktree at once.
- Prefer separate Git worktrees for long-running or high-risk sessions.
- Log enough for debugging, but redact tokens, auth paths, and chat identifiers.

## Implementation Plan

### Phase 1: Repo And Environment

Initial structure:

```text
codex-telegram-bridge/
  README.md
  docs/
    agent/
    project-brief.md
    security.md
    operations.md
  .env.example
  .gitignore
  package.json
```

Verify local prerequisites:

```powershell
node --version
npm --version
codex --version
codex login status
```

### Phase 2: Direct Bridge Spike

Verify:

- Bot starts with long polling.
- User allowlist works.
- `/sessions` reads local Codex sessions.
- `/attach <id>` resumes an existing Codex session.
- `/new` starts a fresh session in an allowed project.
- Plain text messages continue the selected session.
- Model and reasoning effort commands work.
- Streaming output is readable in Telegram.
- Tool output is neither too noisy nor too hidden.
- Abort or interrupt works.
- Local auth works with the existing Codex login.

### Phase 3: Gap Patches

Patch or add:

- Active session monitoring.
- Watch subscriptions and idle notifications.
- Project-specific usage views.
- Stronger approval UI if needed.
- Project allowlist and Windows path handling.
- Safer launch profiles.
- Service runner documentation.
- Operations docs for restart and logging.

### Phase 4: Production Local Run

Run locally under a process manager or scheduled startup.

Options:

- PM2 via Node.js.
- Windows Task Scheduler.
- NSSM Windows service wrapper.
- systemd on Linux.

Operational commands should include:

- start bot
- stop bot
- restart bot
- show logs
- show current Codex auth status
- show active Telegram-to-Codex session bindings

## Expected Telegram Commands

Target command set:

| Command | Purpose |
|---|---|
| `/start` | Show current status |
| `/help` | Show command list |
| `/new` | Start new Codex session |
| `/sessions` | Browse recent local Codex sessions |
| `/attach <session_id>` | Attach Telegram chat/topic to an existing Codex session |
| `/session` | Show current session, model, access mode, and usage |
| `/status` | Show active session status |
| `/active` | List active Codex sessions in monitored roots |
| `/watch` | Subscribe to an active session |
| `/watches` | List watched sessions |
| `/unwatch` | Stop watching a session |
| `/usage` | Show token, cost, and work-time estimates |
| `/model` | Pick model |
| `/effort` | Pick reasoning effort |
| `/launch_profiles` | Pick launch profile |
| `/abort` | Stop current bridge-owned turn |
| `/handback` | Mark the session ready to resume locally |

## Key Open Questions

- Should Telegram control only bot-started sessions, or also attach to sessions
  currently active in the Codex desktop app?
- Should each Telegram topic map to one project/session?
- Do group chats need read-only visibility?
- Do voice input and file uploads belong in the public default, or only as
  optional local features?
- Do GitHub PR workflows belong in this bridge, or should they stay inside Codex?

## Sources

- Codex CLI: https://developers.openai.com/codex/cli
- Codex SDK: https://developers.openai.com/codex/sdk
- Codex App Server: https://developers.openai.com/codex/app-server
- Codex Authentication: https://developers.openai.com/codex/auth
- Codex Pricing: https://developers.openai.com/codex/pricing
- Telegram Bot API: https://core.telegram.org/bots/api
