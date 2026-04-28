# Security Baseline

This bridge controls a local coding agent from Telegram, so the default stance is narrow access and explicit confirmation.

## Required Controls

- Before making a repository public, complete the public release checklist for
  secrets, logs, package metadata, license/provenance, and setup docs.
- Keep `.env` out of git.
- Require a Telegram user allowlist before the bot accepts any command.
- Require an explicit project-root allowlist before starting Codex in a directory.
- Reject paths outside the configured project roots after resolving symlinks and relative segments.
- Default new sessions to `workspace-write` or stricter.
- Treat `danger-full-access` as opt-in and require an additional confirmation step.
- Keep group chats, Telegram-initiated login, assistant-output previews, raw
  error details, and automatic artifact delivery disabled unless explicitly
  needed.
- Do not expose local Codex auth files, such as `.codex/auth.json`.
- Do not copy Codex sessions or the session index into this repository.
- Do not run multiple writing Codex turns in the same worktree at once.
- Redact tokens, auth paths, and chat identifiers from logs.

## Features Disabled by Default

- Arbitrary shell command endpoints.
- File uploads.
- Voice transcription.
- Full filesystem access.
- Any extra LLM or transcription API.

## Operational Rule

Telegram should be a control surface for local Codex, not a new authority layer. If an action would be risky from the desktop, it is riskier from Telegram and should require an explicit confirmation flow.
