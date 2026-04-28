const SECRET_ASSIGNMENT_RE =
  /\b(TELEGRAM_BOT_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/gi;
const TELEGRAM_TOKEN_RE = /\b\d{7,}:[A-Za-z0-9_-]{20,}\b/g;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const WINDOWS_USER_PATH_RE =
  /(?:\\\\\?\\)?[A-Za-z]:\\Users\\[^\\\s"'`]+(?:\\[^\\\s"'`]+)*/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function redactForLog(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(SECRET_ASSIGNMENT_RE, "$1=[redacted]")
    .replace(TELEGRAM_TOKEN_RE, "[redacted-telegram-token]")
    .replace(OPENAI_KEY_RE, "[redacted-openai-key]")
    .replace(WINDOWS_USER_PATH_RE, "[redacted-local-path]")
    .replace(UUID_RE, "[redacted-id]");
}

export function formatLogError(error: unknown): string {
  return redactForLog(error);
}
