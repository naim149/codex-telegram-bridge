# Operations

This document is for the person or agent running the bridge on a local host.

## Local Prerequisites

Expected on the host:

- Node.js 22 or newer.
- npm.
- Git.
- Codex CLI available through `codex` or `CODEX_BIN`.
- Codex logged in locally with the account the bridge should use.
- A configured Telegram bot token.
- At least one allowed Telegram user ID.
- At least one allowed project root.

Check versions and auth:

```powershell
node --version
npm --version
git --version
codex --version
codex login status
```

Install repo dependencies:

```powershell
cd <repo-path>
npm install
```

## Required Local Configuration

Create `.env` from the template:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux:

```bash
cp .env.example .env
```

Required values:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_IDS`
- `CODEX_WORKSPACE`
- `ALLOWED_PROJECT_ROOTS`
- `CODEX_SESSION_BACKEND=app-server`

Usually useful:

- `CODEX_HOME`
- `CODEX_BIN`
- `MONITORED_PROJECT_ROOTS`
- `CODEX_MODEL`
- `CODEX_SANDBOX_MODE`
- `CODEX_APPROVAL_POLICY`
- `ENABLE_GROUP_CHATS=false`
- `ENABLE_TELEGRAM_LOGIN=false`
- `SHOW_ASSISTANT_OUTPUT_IN_TELEGRAM=false`
- `SHOW_ERROR_DETAILS_IN_TELEGRAM=false`
- `AUTO_SEND_ARTIFACTS=false`

`ALLOWED_PROJECT_ROOTS` means the bot may launch or continue Codex work there.
`MONITORED_PROJECT_ROOTS` means the bot may inspect active sessions there for
`/active` and `/watch`, but that setting alone does not grant control/write
access.

Example Windows values:

```text
CODEX_HOME=C:\Users\YourName\.codex
CODEX_WORKSPACE=C:\Users\YourName\Projects\example-app
ALLOWED_PROJECT_ROOTS=C:\Users\YourName\Projects\example-app,C:\Users\YourName\Projects\another-repo
MONITORED_PROJECT_ROOTS=C:\Users\YourName\Projects\example-app,C:\Users\YourName\Projects\another-repo
```

Keep `.env` local. Do not commit it.

Public-safe defaults keep group chats, Telegram-initiated login, assistant-output
previews, raw error details, voice input, file uploads, and automatic artifact
delivery disabled unless you explicitly turn them on.

## Build And Verify

```powershell
npm test
npm run build
```

## Foreground Run

```powershell
cd <repo-path>
npm start
```

Use foreground mode while debugging because errors are visible immediately.

## Background Run

```powershell
$root = '<repo-path>'
Set-Location $root
npm run build
$proc = Start-Process -FilePath 'node' `
  -ArgumentList 'dist/index.js' `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -PassThru
$proc.Id
```

Find the running bridge:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*dist/index.js*' } |
  Select-Object ProcessId,CommandLine
```

Stop it:

```powershell
Stop-Process -Id <PID>
```

Restart it:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*dist/index.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$root = '<repo-path>'
npm --prefix $root run build
$proc = Start-Process -FilePath 'node' `
  -ArgumentList 'dist/index.js' `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -PassThru
$proc.Id
```

## First Telegram Smoke Test

From the allowlisted Telegram account:

1. Send `/start`.
2. Send `/auth`.
3. Send `/session`.
4. Send `/active`.
5. Send `/watch` and choose an active Codex session if one exists.
6. Send `/usage` and choose a project if prompted.
7. Send `/limits`.

Expected result:

- The bot answers only allowlisted users.
- `/auth` reports the local Codex login.
- `/active` lists sessions inside monitored roots.
- `/watch` can subscribe to an active detected session.
- `/usage` does not mix unrelated project totals when project roots are
  configured.
- `/limits` reports the latest observed Codex rate-limit snapshot.

## Common Problems

Telegram does not respond:

- The bridge process is not running.
- `.env` has the wrong bot token.
- The sender's numeric Telegram ID is not allowlisted.
- Another process is already polling the same Telegram bot token.

`/active` or `/watch` misses a session:

- The project is not inside `MONITORED_PROJECT_ROOTS`.
- Codex has not written recent state for that session.
- The session is a related session or old session and is filtered by the current
  view.

`/sessions` shows duplicate projects:

- Check for different path forms such as `\\?\C:\...` and `C:\...`.
- Check for old folders with similar names.
- Confirm the workspace root in the Codex session metadata is the intended
  project.

Usage costs look lower or higher than expected:

- The bridge reports estimates from local Codex usage data, not an official
  ChatGPT invoice.
- Pricing depends on the model slug recorded in local Codex usage data.
- `/usage` should be filtered to the intended project when multiple roots are
  configured.

## Production Runner Options

The current repo supports manual local running. For a more durable setup, use
one of:

- Windows Task Scheduler.
- PM2.
- NSSM Windows service wrapper.
- systemd on Linux.

Any production runner should provide:

- start
- stop
- restart
- current process status
- log viewing
- a way to confirm `codex login status`
