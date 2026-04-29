# Codex Telegram Bridge

Local Telegram control surface for Codex sessions.

This project runs a Telegram bot on your own machine so an allowlisted Telegram
user can start, resume, monitor, and respond to local Codex work. It uses the
local Codex CLI and the host machine's existing Codex login. It does not add a
second LLM layer.

## Status

The bridge is a working local prototype with tests and operator docs. It is
useful for real testing, but it should still be reviewed carefully before being
used as an always-on service.

This repo is intended as a GitHub source project, not an npm-published package.

## Security Model

- Telegram access is restricted to numeric user IDs in
  `TELEGRAM_ALLOWED_USER_IDS`.
- Codex control/write access is restricted to `ALLOWED_PROJECT_ROOTS`.
- Read-only session monitoring is restricted to `MONITORED_PROJECT_ROOTS`.
- `.env`, Codex auth files, Codex sessions, logs, dependencies, and build output
  are ignored by Git.
- Voice input and file uploads are disabled by default.
- Group chats, Telegram-initiated login, assistant-output previews, and raw
  error details are disabled by default. Automatic artifact delivery is also
  disabled by default.
- `danger-full-access` style launch profiles should be treated as explicit
  opt-in only.

## Requirements

- Windows, macOS, or Linux host with shell access.
- Node.js 22 or newer.
- npm.
- Git.
- Codex CLI installed and authenticated locally.
- A Telegram bot token from `@BotFather`.

Check the local toolchain:

```powershell
node --version
npm --version
git --version
codex --version
codex login status
```

## Quick Start

Clone the repo from your fork or chosen remote:

```powershell
git clone <repo-url> codex-telegram-bridge
cd codex-telegram-bridge
```

Install dependencies:

```powershell
npm install
```

Create local configuration:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux:

```bash
cp .env.example .env
```

Edit `.env` with real local values:

```text
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_ALLOWED_USER_IDS=<numeric Telegram user id>
CODEX_HOME=<absolute path to your Codex home>
CODEX_WORKSPACE=<absolute path to the default workspace>
ALLOWED_PROJECT_ROOTS=<comma-separated absolute paths Codex may control>
MONITORED_PROJECT_ROOTS=<comma-separated absolute paths to monitor>
CODEX_SESSION_BACKEND=app-server
CODEX_MODEL=<optional default model>
CODEX_SANDBOX_MODE=workspace-write
CODEX_APPROVAL_POLICY=on-request
ENABLE_GROUP_CHATS=false
ENABLE_TELEGRAM_LOGIN=false
SHOW_ASSISTANT_OUTPUT_IN_TELEGRAM=false
SHOW_ERROR_DETAILS_IN_TELEGRAM=false
AUTO_SEND_ARTIFACTS=false
```

Build and test:

```powershell
npm test
npm run build
```

Run:

```powershell
npm start
```

## Telegram Setup

1. In Telegram, open `@BotFather`.
2. Run `/newbot`.
3. Choose a display name and bot username.
4. Copy the bot token into `.env` as `TELEGRAM_BOT_TOKEN`.
5. Find the numeric Telegram user ID for each allowed operator.
6. Put those IDs in `.env` as `TELEGRAM_ALLOWED_USER_IDS`.

One way to find your user ID is to send `/start` to the bot, then inspect:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
```

Use the `message.from.id` value. Treat that URL like a secret while it contains
the bot token.

The bridge sets its Telegram command menu on startup, so BotFather command menu
configuration is optional.

## Project Roots

Use absolute paths.

Example:

```text
CODEX_WORKSPACE=C:\Users\YourName\Projects\example-app
ALLOWED_PROJECT_ROOTS=C:\Users\YourName\Projects\example-app,C:\Users\YourName\Projects\another-repo
MONITORED_PROJECT_ROOTS=C:\Users\YourName\Projects\example-app,C:\Users\YourName\Projects\another-repo
```

`ALLOWED_PROJECT_ROOTS` controls where Telegram may cause Codex to work.
`MONITORED_PROJECT_ROOTS` controls what appears in `/active` and `/watch`.

Use monitored roots for visibility. Use allowed roots only for repos where
Telegram-triggered Codex writes are acceptable.

## Telegram Commands

The Telegram menu shows the main commands. `/help` shows the full command list.

Core:

- `/start` checks that the bot is reachable.
- `/help` shows all commands.
- `/new` creates a new Codex session in the default workspace.
- `/session` shows the active session.
- `/sessions` browses recent main sessions.
- `/sessions all` includes related sessions.
- `/attach <session_id>` attaches a chat or topic to an existing Codex session.
- `/status` checks the current session state and latest saved output.

Monitoring:

- `/active` lists currently active Codex sessions in monitored roots.
- `/watch` lets you choose an active session to watch.
- `/watches` lists watched sessions with current run, total work, tokens, and cost
  when available.
- `/unwatch` stops watching a session.

Usage:

- `/usage` shows token totals, estimated cost, and total work time.
- `/usage <project>` filters usage by project when multiple roots are
  configured.
- `/cost` is an alias for `/usage`.
- `/limits` shows the latest observed Codex rate-limit snapshot.

Live turn controls:

- `/answer <text>` answers a Codex input request when the bridge can observe it.
- `/steer <text>` sends extra input to a running app-server turn.
- `/abort` interrupts the active bridge-owned turn.
- `/retry` resends the last prompt in the active chat binding.

Configuration:

- `/model` views or changes the model for new turns.
- `/effort` sets reasoning effort.
- `/launch_profiles` selects a launch profile.
- `/auth` checks local Codex auth.
- `/login` starts Codex login when `ENABLE_TELEGRAM_LOGIN=true`.
- `/logout` signs out when `ENABLE_TELEGRAM_LOGIN=true`.
- `/voice` shows whether voice input is enabled.

## Agent-Assisted Setup

If you want another coding agent to configure the bridge for you, use:

- [Agent setup instructions](docs/agent/README.md)
- [User prompt template](docs/agent/user-prompt-template.md)

The agent should ask you for secrets and local paths, write them only to `.env`,
run the verification commands, and never commit private configuration.

## Operations

See [Operations](docs/operations.md) for foreground/background runs,
restart commands, smoke tests, and troubleshooting.

## Source Control Rules

Track:

- TypeScript source under `src/`.
- Tests under `test/`.
- Documentation under `docs/`.
- `package.json`, `package-lock.json`, `tsconfig.json`, and `.env.example`.

Do not track:

- `.env`
- `node_modules/`
- `dist/`
- `logs/`
- `.telecodex/`
- Codex auth or session files.

Before committing:

```powershell
git status --short
npm test
npm run build
git diff --check
```

## Public Release Checklist

Before making a fork or repo public:

- Rotate any Telegram bot token used during local testing.
- Confirm `.env`, logs, `.telecodex`, `dist`, Codex auth files, and Codex
  session files are not tracked.
- Run `git status --ignored --short` and verify ignored local files are not part
  of the release archive.
- Run `npm test`, `npm run build`, `npm audit --omit=dev`, and
  `npm pack --dry-run`.
- Check Git history for private paths, project names, tokens, and chat IDs. If
  anything private appears in history, publish from a fresh clean repository
  instead of making that history public.
- Review package metadata, license/provenance, and setup docs.

## More Docs

- [Operations](docs/operations.md)
- [Security baseline](docs/security.md)
- [Public release checklist](docs/public-release-checklist.md)
- [Project brief](docs/project-brief.md)
- [Work done](docs/work-done.md)
