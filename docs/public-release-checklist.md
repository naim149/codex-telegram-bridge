# Public Release Checklist

Use this before publishing the project on GitHub or sharing it publicly.

## Required

- Rotate any Telegram bot token used during private testing.
- Confirm no local secrets are tracked:

```powershell
git ls-files .env .env.* logs .telecodex dist
```

- Review ignored local files and do not include them in screenshots, archives,
  or release artifacts:

```powershell
git status --ignored --short
```

- Scan the current tree and Git history for private values:

```powershell
rg -n "TELEGRAM_BOT_TOKEN=.+|CODEX_API_KEY=.+|OPENAI_API_KEY=.+|C:\\Users\\|auth.json|session_index|\\.codex" .
git rev-list --all | ForEach-Object { git grep -I -n "C:\\Users\\|auth.json|session_index|TELEGRAM_BOT_TOKEN" $_ -- . 2>$null }
```

- If private values appear in history, publish from a fresh repository with a
  single clean initial commit.
- Run verification:

```powershell
npm test
npm run build
npm audit --omit=dev
npm pack --dry-run
```

- Confirm `.env.example` uses safe defaults:
  - `ENABLE_GROUP_CHATS=false`
  - `ENABLE_TELEGRAM_LOGIN=false`
  - `ENABLE_VOICE_INPUT=false`
  - `ENABLE_FILE_UPLOADS=false`
  - `SHOW_ASSISTANT_OUTPUT_IN_TELEGRAM=false`
  - `SHOW_ERROR_DETAILS_IN_TELEGRAM=false`
  - `AUTO_SEND_ARTIFACTS=false`
  - `CODEX_APPROVAL_POLICY=on-request`

## Recommended

- Keep the npm package private unless package publishing is intentional.
- Confirm license and provenance before sharing.
- Keep setup docs generic: no real usernames, local project names, chat IDs, or
  machine paths.
- Use a new public GitHub repo if the private development repo history contains
  local paths or project names.
