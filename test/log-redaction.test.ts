import { describe, expect, it } from "vitest";

import { redactForLog } from "../src/log-redaction.js";

describe("log redaction", () => {
  it("redacts common secrets and local paths", () => {
    const telegramToken = "123456789:" + "abcdefghijklmnopqrstuvwxyz";
    const openAiKey = "sk-" + "test1234567890";
    const codexKey = "sk-" + "test9876543210";
    const redacted = redactForLog(
      [
        `TELEGRAM_BOT_TOKEN=${telegramToken}`,
        `OPENAI_API_KEY=${openAiKey}`,
        `CODEX_API_KEY='${codexKey}'`,
        "C:\\Users\\Alice\\Projects\\PrivateRepo\\file.ts",
        "019dd561-f4f7-7fb0-aff8-bba36e3885d6",
      ].join(" "),
    );

    expect(redacted).not.toContain(telegramToken);
    expect(redacted).not.toContain(openAiKey);
    expect(redacted).not.toContain(codexKey);
    expect(redacted).not.toContain("C:\\Users\\Alice");
    expect(redacted).not.toContain("019dd561-f4f7-7fb0-aff8-bba36e3885d6");
    expect(redacted).toContain("TELEGRAM_BOT_TOKEN=[redacted]");
    expect(redacted).toContain("[redacted-local-path]");
    expect(redacted).toContain("[redacted-id]");
  });
});
