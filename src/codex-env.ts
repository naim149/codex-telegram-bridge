const CODEX_CHILD_ENV_ALLOWLIST = new Set([
  "APPDATA",
  "CODEX_HOME",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "Path",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

export function buildCodexChildEnv(apiKey?: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of CODEX_CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (apiKey) {
    env.CODEX_API_KEY = apiKey;
  }

  return env;
}
