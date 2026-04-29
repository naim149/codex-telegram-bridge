# Agent Setup Instructions

Use this guide when an AI coding agent is asked to configure Codex Telegram
Bridge for a user.

The goal is to make the bridge run locally without leaking private information
into Git.

## Non-Negotiable Rules

- Do not commit `.env`.
- Do not print the Telegram bot token back to the user unless they explicitly ask
  for local verification and understand the risk.
- Do not commit Telegram user IDs, chat IDs, Codex auth files, Codex session
  files, logs, or local machine paths.
- Keep public docs generic. Put machine-specific values only in `.env`.
- Do not widen `ALLOWED_PROJECT_ROOTS` without the user's explicit approval.
- Treat `danger-full-access` as opt-in and risky.
- Keep group chats, Telegram-initiated login, assistant-output previews, raw
  error details, and automatic artifact delivery disabled unless the user
  explicitly asks for them.

## Ask The User For

Ask concise questions and collect:

1. Telegram bot token from `@BotFather`.
2. Numeric Telegram user ID or IDs allowed to use the bot.
3. Default workspace path for new Codex sessions.
4. Project roots Telegram may control/write to.
5. Project roots Telegram may monitor read-only.
6. Preferred model.
7. Sandbox mode and approval policy.
8. Whether voice input should be enabled.
9. Whether file uploads should be enabled.
10. Whether the bridge should be started now after configuration.

If the user does not know their Telegram user ID, tell them to send `/start` to
their bot, then inspect the Telegram `getUpdates` response locally and use
`message.from.id`.

## Setup Steps

1. Inspect the repo.

```powershell
git status --short
node --version
npm --version
codex --version
codex login status
```

2. Install dependencies.

```powershell
npm install
```

3. Create `.env` if it does not exist.

```powershell
Copy-Item .env.example .env
```

4. Fill `.env` with the values the user provided.

Required:

```text
TELEGRAM_BOT_TOKEN=<secret>
TELEGRAM_ALLOWED_USER_IDS=<numeric ids>
CODEX_WORKSPACE=<absolute default workspace path>
ALLOWED_PROJECT_ROOTS=<comma-separated absolute paths>
CODEX_SESSION_BACKEND=app-server
```

Recommended:

```text
CODEX_HOME=<absolute Codex home path>
MONITORED_PROJECT_ROOTS=<comma-separated absolute paths>
CODEX_MODEL=<model>
CODEX_SANDBOX_MODE=workspace-write
CODEX_APPROVAL_POLICY=on-request
ENABLE_GROUP_CHATS=false
ENABLE_TELEGRAM_LOGIN=false
SHOW_ASSISTANT_OUTPUT_IN_TELEGRAM=false
SHOW_ERROR_DETAILS_IN_TELEGRAM=false
AUTO_SEND_ARTIFACTS=false
```

5. Verify.

```powershell
npm test
npm run build
```

6. Start the bridge if requested.

```powershell
npm start
```

For a background Windows run:

```powershell
$root = (Get-Location).Path
npm run build
$proc = Start-Process -FilePath 'node' `
  -ArgumentList 'dist/index.js' `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -PassThru
$proc.Id
```

## Smoke Test

Ask the user to send these Telegram commands:

1. `/start`
2. `/auth`
3. `/session`
4. `/active`
5. `/usage`
6. `/limits`

Expected:

- The bot replies only to allowlisted users.
- `/auth` reports a valid Codex login.
- `/active` sees sessions under monitored roots.
- `/usage` reports the intended project scope.
- `/limits` reports the latest observed 5-hour and weekly Codex limit windows.

## Final Report Template

When done, report:

- Whether the repo is clean.
- Whether `.env` was created or updated.
- Which project roots are allowed and monitored, without exposing secrets.
- Whether tests and build passed.
- Whether the bridge is running and how to stop it.
- Any manual action still required from the user.

Do not include the bot token in the final response.
