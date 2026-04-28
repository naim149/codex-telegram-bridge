# User Prompt Template

Paste this into a coding agent when you want it to configure this project
locally.

```text
Set up Codex Telegram Bridge on this machine.

Your goals:
- Configure the local `.env` from `.env.example`.
- Ask me for every value you need instead of guessing private paths or secrets.
- Keep all secrets and machine-specific values out of Git.
- Verify Codex CLI auth, install dependencies, run tests, build, and optionally start the bridge.
- Leave the repo clean except ignored local/runtime files.

Ask me for:
1. Telegram bot token from @BotFather.
2. Numeric Telegram user ID or IDs allowed to control the bot.
3. Default workspace path for new Codex sessions.
4. Project roots the bot may control/write to.
5. Project roots the bot may monitor read-only with /active and /watch.
6. Preferred model.
7. Sandbox mode and approval policy.
8. Whether voice input should be enabled.
9. Whether file uploads should be enabled.
10. Whether to start the bridge after setup.

Rules:
- Do not commit `.env`.
- Do not print my Telegram token in your final answer.
- Do not commit Codex auth files, Codex session files, logs, chat IDs, or local machine paths.
- Do not broaden allowed project roots without asking me.
- Treat danger-full-access as opt-in and risky.
- Keep group chats, Telegram login, assistant-output previews, raw error
  details, and automatic artifact delivery disabled unless I explicitly ask for
  them.

After setup, run:
- npm test
- npm run build

Then tell me:
- What you configured, excluding secrets.
- Whether tests/build passed.
- Whether the bridge is running.
- The PID if you started it in the background.
- How to stop or restart it.
```
