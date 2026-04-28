# Work Done

This repo implements a local Telegram control surface for Codex sessions.

The design was informed by the general pattern of Telegram-to-agent bridges,
then adapted for a Windows-friendly Codex collaboration flow.

## Maturity

Current maturity is:

- runnable local prototype
- useful for real testing
- source-controlled with tests and operator docs
- not yet a polished production service

In practice, it is beyond a mockup. It can run real Codex sessions and monitor
existing sessions, but it still needs hardening before being treated as an
always-on service.

## Starting Point Vs Custom Work

Implemented in this repo:

- Windows-specific Codex executable handling
- repo-local Codex CLI path support
- allowlisted project-root enforcement
- separate read-only monitored roots for `/active` and `/watch`
- app-server based live collaboration flow
- session attach, switch, and new-thread behavior
- Telegram `/status`
- Telegram `/active`, `/watch`, `/watches`, and `/unwatch`
- Telegram `/usage` and `/cost`
- project-specific usage filtering
- workspace path normalization to avoid duplicate `\\?\` and normal Windows
  paths
- filtering related sessions out of normal `/sessions`
- optional related-session browsing with `/sessions all` and `/sessions related`
- token accounting, estimated cost, and total work time
- estimated work-time calculation from rollout timestamps
- current-run time reporting for watched sessions
- tests for the behavior above
- local setup, security, and operations documentation

## Main Delivered Changes

Recent implementation history:

- initial project scaffold
- local Codex session control from Telegram
- Windows Codex executable handling
- Codex app-server collaboration
- status, monitoring, watch, usage, and cost commands
- safer public-facing Telegram messages
- local setup, security, and operations documentation

## Core Implementation Files

- `src/bot.ts`
- `src/thread-watch.ts`
- `src/codex-session.ts`
- `src/codex-state.ts`
- `src/codex-app-server.ts`
- `src/codex-auth.ts`
- `src/codex-usage.ts`
- `src/config.ts`
- `src/session-registry.ts`

## Current Capabilities

The current repo can:

- run a Telegram bot locally on Windows
- create, attach, and switch Codex sessions
- collaborate with app-server turns
- show current session status
- monitor active Codex sessions in configured roots
- notify Telegram when watched sessions become idle or fail
- answer pending Codex questions from Telegram when the bridge owns or can
  observe the input request
- report token totals, estimated cost, and total work time
- separate usage by configured project root

## Known Limitations

Still not mature in these areas:

- Telegram answering is not a universal desktop-session multiplexer; some Codex
  desktop turns can be monitored but not fully controlled.
- Cost is estimated from local Codex usage data and model pricing. It is not an
  official ChatGPT invoice.
- Work time is heuristic and based on local session events, not exact human focus
  time.
- Voice exists in code but is disabled by default and not finalized for a free
  Windows local backend.
- No Windows service wrapper or scheduled startup is committed yet.
- Group-chat and multi-user flows are intentionally not the default security
  posture.

## Bottom Line

This is best described as:

- a customized local bridge for Codex and Telegram
- with real implementation work already done
- now documented enough for another agent to set up locally
- still early enough that scope and limitations should remain visible
