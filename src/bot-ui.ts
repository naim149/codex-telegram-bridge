import { escapeHTML } from "./format.js";

export interface DualText {
  html: string;
  plain: string;
}

/**
 * Grouped command reference for /help.
 */
export function renderHelpMessage(): DualText {
  const sections = [
    {
      title: "💬 Session",
      commands: [
        ["/new", "Start a new session"],
        ["/session", "Current session"],
        ["/status", "Current session status"],
        ["/active", "List active Codex sessions"],
        ["/watch", "Watch an active session"],
        ["/watches", "List watched sessions"],
        ["/unwatch", "Stop watching a session"],
        ["/usage", "Token and cost totals"],
        ["/sessions", "Browse & switch sessions"],
        ["/attach", "Attach an existing session"],
        ["/handback", "Resume locally"],
        ["/abort", "Cancel current operation"],
        ["/answer", "Answer a Codex question"],
        ["/steer", "Send input to a running turn"],
        ["/retry", "Resend the last prompt"],
      ],
    },
    {
      title: "🤖 Model",
      commands: [
        ["/launch_profiles", "Select launch profile"],
        ["/model", "View & change model"],
        ["/effort", "Set reasoning effort"],
      ],
    },
    {
      title: "🔐 Auth",
      commands: [
        ["/auth", "Check auth status"],
        ["/login", "Start authentication"],
        ["/logout", "Sign out"],
      ],
    },
    {
      title: "ℹ️ Utility",
      commands: [
        ["/start", "Welcome & status"],
        ["/help", "This reference"],
        ["/voice", "Voice transcription status"],
      ],
    },
  ];

  const htmlLines: string[] = [];
  const plainLines: string[] = [];

  for (const section of sections) {
    htmlLines.push(`<b>${escapeHTML(section.title)}</b>`);
    plainLines.push(section.title);
    for (const [cmd, desc] of section.commands) {
      htmlLines.push(`  ${cmd} — ${escapeHTML(desc)}`);
      plainLines.push(`  ${cmd} — ${desc}`);
    }
    htmlLines.push("");
    plainLines.push("");
  }

  while (htmlLines.at(-1) === "") {
    htmlLines.pop();
  }
  while (plainLines.at(-1) === "") {
    plainLines.pop();
  }

  return {
    html: htmlLines.join("\n"),
    plain: plainLines.join("\n"),
  };
}

/**
 * Short /start message for first-time users (no prior interaction in this context).
 */
export function renderWelcomeFirstTime(authWarning?: string): DualText {
  const htmlLines = [
    "<b>👋 TeleCodex is ready.</b>",
    "",
    "Send a message to start chatting with Codex.",
    "You can also send voice notes, photos, or documents.",
    "",
    "Type /help for all commands.",
  ];
  const plainLines = [
    "👋 TeleCodex is ready.",
    "",
    "Send a message to start chatting with Codex.",
    "You can also send voice notes, photos, or documents.",
    "",
    "Type /help for all commands.",
  ];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Concise /start message for returning users with session info.
 */
export function renderWelcomeReturning(
  sessionHtml: string,
  sessionPlain: string,
  isTopicSession: boolean,
  authWarning?: string,
): DualText {
  const label = isTopicSession ? "TeleCodex (topic session)" : "TeleCodex";

  const htmlLines = [`<b>👋 ${escapeHTML(label)}</b>`, "", sessionHtml];
  const plainLines = [`👋 ${label}`, "", sessionPlain];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Format a session button label for /sessions list.
 * Compact, group-safe session label.
 */
export function formatSessionLabel(
  options: {
    workspace: string;
    title: string;
    relativeTime: string;
    model?: string;
    isActive: boolean;
    isSubAgent?: boolean;
    agentNickname?: string;
  },
): string {
  const prefix = options.isActive ? "✅" : "📁";
  const title = trimLabel(options.title || "(untitled)", 20) || "(untitled)";
  const time = options.relativeTime;

  let label = `${prefix} ${title} | ${time}`;

  if (options.isSubAgent) {
    label += ` | sub${options.agentNickname ? `:${trimLabel(options.agentNickname, 8)}` : ""}`;
  }

  if (options.model) {
    const shortModel = trimLabel(options.model, 10);
    label += ` | ${shortModel}`;
  }

  return label;
}

function trimLabel(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

