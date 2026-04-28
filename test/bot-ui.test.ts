import { describe, expect, it } from "vitest";

import {
  formatSessionLabel,
  renderHelpMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "../src/bot-ui.js";

describe("bot-ui", () => {
  describe("renderHelpMessage", () => {
    it("contains all command groups", () => {
      const { html, plain } = renderHelpMessage();
      expect(html).toContain("Session");
      expect(html).toContain("Model");
      expect(html).toContain("Auth");
      expect(html).toContain("Utility");
      expect(plain).toContain("/new");
      expect(plain).toContain("/help");
      expect(plain).toContain("/retry");
      expect(plain).toContain("/launch_profiles");
      expect(plain).toContain("/usage");
      expect(plain).toContain("/active");
      expect(plain).toContain("/watch");
      expect(plain).toContain("/watches");
      expect(plain).toContain("/unwatch");
    });

    it("lists all 24 commands", () => {
      const { plain } = renderHelpMessage();
      const commandMatches = plain.match(/\/\w+/g) ?? [];
      expect(commandMatches.length).toBe(24);
    });

    it("returns valid HTML with bold tags", () => {
      const { html } = renderHelpMessage();
      expect(html).toContain("<b>");
      expect(html).toContain("</b>");
    });
  });

  describe("renderWelcomeFirstTime", () => {
    it("shows welcome without auth warning", () => {
      const { html, plain } = renderWelcomeFirstTime();
      expect(html).toContain("TeleCodex is ready");
      expect(plain).toContain("/help");
      expect(html).not.toContain("Not authenticated");
    });

    it("includes auth warning when provided", () => {
      const { html, plain } = renderWelcomeFirstTime("Not authenticated");
      expect(html).toContain("Not authenticated");
      expect(plain).toContain("Not authenticated");
    });
  });

  describe("renderWelcomeReturning", () => {
    it("shows session info for returning user", () => {
      const { html, plain } = renderWelcomeReturning(
        "<b>State:</b> active",
        "State: active",
        false,
      );
      expect(html).toContain("TeleCodex");
      expect(html).toContain("active");
      expect(plain).toContain("active");
    });

    it("shows topic label for topic sessions", () => {
      const { html } = renderWelcomeReturning("", "", true);
      expect(html).toContain("topic session");
    });

    it("includes auth warning when provided", () => {
      const { html } = renderWelcomeReturning("", "", false, "Expired");
      expect(html).toContain("Expired");
    });
  });

  describe("formatSessionLabel", () => {
    it("formats a basic session label without exposing the workspace", () => {
      const label = formatSessionLabel({
        workspace: "/home/user/my-project",
        title: "fix the login bug",
        relativeTime: "3h ago",
        isActive: false,
      });
      expect(label).toContain("fix the login bug");
      expect(label).toContain("3h ago");
      expect(label).not.toContain("my-project");
      expect(label).not.toContain("/home/user");
    });

    it("marks active sessions", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "test",
        relativeTime: "now",
        isActive: true,
      });
      expect(label).toContain("test");
      expect(label).toContain("now");
    });

    it("appends model tag when available", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "test",
        relativeTime: "1m ago",
        model: "gpt-4o",
        isActive: false,
      });
      expect(label).toContain("gpt-4o");
    });

    it("does not expose long workspace names", () => {
      const label = formatSessionLabel({
        workspace: "/home/user/my-very-long-project-name",
        title: "test",
        relativeTime: "1m",
        isActive: false,
      });
      expect(label).not.toContain("my-very-long-project-name");
      expect(label).not.toContain("my-very");
    });

    it("truncates long titles to 20 chars", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "this is an extremely long title that should be truncated",
        relativeTime: "1m",
        isActive: false,
      });
      expect(label.length).toBeLessThan(120);
    });

    it("handles missing title gracefully", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "",
        relativeTime: "5m ago",
        isActive: false,
      });
      expect(label).toContain("(untitled)");
    });

    it("truncates long model names", () => {
      const label = formatSessionLabel({
        workspace: "/p",
        title: "t",
        relativeTime: "1m",
        model: "very-long-model-name-here",
        isActive: false,
      });
      expect(label.length).toBeLessThan(120);
    });
  });
});
