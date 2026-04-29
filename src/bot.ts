import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";

import {
  buildFileInstructions,
  cleanupInbox,
  outboxPath,
  stageFile,
  type StagedFile,
} from "./attachments.js";
import { collectArtifactReport, ensureOutDir, formatArtifactSummary } from "./artifacts.js";
import {
  formatSessionLabel,
  renderHelpMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "./bot-ui.js";
import {
  type CodexPromptInput,
  type CodexSessionCallbacks,
  type CodexSessionInfo,
  type CodexSessionService,
  type CodexSessionStatusSnapshot,
  type PendingUserInputRequest,
} from "./codex-session.js";
import { checkAuthStatus, clearAuthCache, startLogin, startLogout } from "./codex-auth.js";
import {
  findLaunchProfile,
  type CodexApprovalPolicy,
  type CodexLaunchProfile,
  type CodexSandboxMode,
} from "./codex-launch.js";
import {
  getLatestRateLimitSummary,
  summarizeWorkspaceUsage,
  type RateLimitSummary,
  type RateLimitWindowSummary,
  type ThreadUsageSummary,
  type TokenTotals,
  type WorkspaceUsageSummary,
} from "./codex-usage.js";
import { getThread, listWorkspaces } from "./codex-state.js";
import { isWorkspaceAllowed, type TeleCodexConfig, type ToolVerbosity } from "./config.js";
import { contextKeyFromCtx, isTopicContextKey, parseContextKey, type TelegramContextKey } from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML, formatTelegramHTML } from "./format.js";
import { formatLogError } from "./log-redaction.js";
import { SessionRegistry } from "./session-registry.js";
import {
  ThreadWatchService,
  type ThreadStatusSnapshot,
  type ThreadWatchState,
  type WatchRecord,
  type WatchTransition,
} from "./thread-watch.js";
import { getAvailableBackends, transcribeAudio } from "./voice.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const EDIT_DEBOUNCE_MS = 1500;
const TYPING_INTERVAL_MS = 4500;
const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const STREAMING_PREVIEW_LIMIT = 3800;
const FORMATTED_CHUNK_TARGET = 3000;
const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;
const KEYBOARD_PAGE_SIZE = 6;
const NOOP_PAGE_CALLBACK_DATA = "noop_page";
const LAUNCH_PROFILES_COMMAND = "/launch_profiles";

type TelegramChatId = number | string;
type TelegramParseMode = "HTML";
type KeyboardItem = { label: string; callbackData: string };
type SessionListMode = "main" | "all" | "subagents";

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
};

type RenderedText = {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
};

type RenderedChunk = RenderedText & {
  sourceText: string;
};

function paginateKeyboard(items: KeyboardItem[], page: number, prefix: string): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(items.length / KEYBOARD_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = currentPage * KEYBOARD_PAGE_SIZE;
  const pageItems = items.slice(start, start + KEYBOARD_PAGE_SIZE);
  const keyboard = new InlineKeyboard();

  pageItems.forEach((item, index) => {
    keyboard.text(item.label, item.callbackData);
    if (index < pageItems.length - 1 || totalPages > 1) {
      keyboard.row();
    }
  });

  if (totalPages > 1) {
    if (currentPage > 0) {
      keyboard.text("◀️ Prev", `${prefix}_page_${currentPage - 1}`);
    }
    keyboard.text(`${currentPage + 1}/${totalPages}`, NOOP_PAGE_CALLBACK_DATA);
    if (currentPage < totalPages - 1) {
      keyboard.text("Next ▶️", `${prefix}_page_${currentPage + 1}`);
    }
  }

  return keyboard;
}

export function createBot(config: TeleCodexConfig, registry: SessionRegistry): Bot<Context> {
  const bot = new Bot<Context>(config.telegramBotToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

  const contextBusy = new Map<
    TelegramContextKey,
    { processing: boolean; switching: boolean; transcribing: boolean }
  >();
  const pendingSessionPicks = new Map<TelegramContextKey, string[]>();
  const pendingWorkspacePicks = new Map<TelegramContextKey, string[]>();
  const pendingSessionButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingWorkspaceButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingLaunchPicks = new Map<TelegramContextKey, string[]>();
  const pendingLaunchButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingUnsafeLaunchConfirmations = new Map<TelegramContextKey, string>();
  const pendingModelButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingEffortButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingWatchPicks = new Map<TelegramContextKey, string[]>();
  const pendingWatchButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingUnwatchPicks = new Map<TelegramContextKey, string[]>();
  const pendingUnwatchButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingUsagePicks = new Map<TelegramContextKey, string[]>();
  const pendingUsageButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const lastPromptInput = new Map<TelegramContextKey, CodexPromptInput>();
  const threadWatcher = new ThreadWatchService(config);

  registry.onRemove((key) => {
    contextBusy.delete(key);
    pendingLaunchPicks.delete(key);
    pendingLaunchButtons.delete(key);
    pendingUnsafeLaunchConfirmations.delete(key);
    pendingWatchPicks.delete(key);
    pendingWatchButtons.delete(key);
    pendingUnwatchPicks.delete(key);
    pendingUnwatchButtons.delete(key);
    pendingUsagePicks.delete(key);
    pendingUsageButtons.delete(key);
    lastPromptInput.delete(key);
  });

  threadWatcher.start(async (transition) => {
    const rendered = renderWatchTransition(transition, {
      includeAssistantOutput: config.showAssistantOutputInTelegram,
      includeErrorDetails: config.showErrorDetailsInTelegram,
    });
    const target = parseContextKey(transition.watch.contextKey);
    try {
      await sendTextMessage(bot.api, target.chatId, rendered.text, {
        fallbackText: rendered.fallbackText,
        parseMode: rendered.parseMode,
        messageThreadId: target.messageThreadId,
      });
    } catch (error) {
      console.error("Failed to send watch notification:", formatLogError(error));
      throw error;
    }
  });

  const getBusyState = (
    contextKey: TelegramContextKey,
  ): { processing: boolean; switching: boolean; transcribing: boolean } => {
    let state = contextBusy.get(contextKey);
    if (!state) {
      state = { processing: false, switching: false, transcribing: false };
      contextBusy.set(contextKey, state);
    }
    return state;
  };

  const isBusy = (contextKey: TelegramContextKey): boolean => {
    const state = contextBusy.get(contextKey);
    const session = registry.get(contextKey);
    return Boolean(state?.processing || state?.switching || state?.transcribing || session?.isProcessing());
  };

  const getContextSession = async (
    ctx: Context,
    options?: { deferThreadStart?: boolean },
  ): Promise<{ contextKey: TelegramContextKey; session: CodexSessionService } | null> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return null;
    }

    try {
      const session = await registry.getOrCreate(contextKey, options);
      return { contextKey, session };
    } catch (error) {
      const detail = friendlyErrorText(error);
      console.error("Failed to restore Telegram context:", formatLogError(error));
      await safeReply(
        ctx,
        [
          "<b>Session restore failed.</b>",
          "",
          `<code>${escapeHTML(detail)}</code>`,
          "",
          "Try /new to start clean, or /sessions to switch.",
        ].join("\n"),
        {
          fallbackText: [
            "Session restore failed.",
            "",
            detail,
            "",
            "Try /new to start clean, or /sessions to switch.",
          ].join("\n"),
        },
      );
      return null;
    }
  };

  const updateSessionMetadata = (contextKey: TelegramContextKey, session: CodexSessionService): void => {
    registry.updateMetadata(contextKey, session);
  };

  const isTopicContext = (contextKey: TelegramContextKey): boolean => isTopicContextKey(contextKey);

  const clearLaunchSelectionState = (contextKey: TelegramContextKey): void => {
    pendingLaunchPicks.delete(contextKey);
    pendingLaunchButtons.delete(contextKey);
    pendingUnsafeLaunchConfirmations.delete(contextKey);
  };

  const handlePageCallback = (
    pattern: RegExp,
    prefix: string,
    buttonsMap: Map<TelegramContextKey, KeyboardItem[]>,
    expiredMessage: string,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      const ctxKey = contextKeyFromCtx(ctx);
      const messageId = ctx.callbackQuery.message?.message_id;
      const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
      if (!ctxKey || !messageId || Number.isNaN(page)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const buttons = buttonsMap.get(ctxKey);
      if (!buttons) {
        await ctx.answerCallbackQuery({ text: expiredMessage });
        return;
      }
      await ctx.answerCallbackQuery();
      try {
        const keyboard = paginateKeyboard(buttons, page, prefix);
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: keyboard });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error(`Failed to update ${prefix} keyboard page`, error);
        }
      }
    });
  };

  const sendBusyReply = async (ctx: Context): Promise<void> => {
    await safeReply(ctx, escapeHTML("Still working on previous message..."), {
      fallbackText: "Still working on previous message...",
    });
  };

  const setReaction = async (ctx: Context, emoji: "👀" | "👍" | "❤" | "🔥" | "👏"): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
    } catch {
      // Reactions may not be available in all chats — fail silently.
    }
  };

  const clearReaction = async (ctx: Context): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, []);
    } catch {
      // Fail silently.
    }
  };

  const ensureActiveThread = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: CodexSessionService,
  ): Promise<boolean> => {
    if (session.hasActiveThread()) {
      return true;
    }

    try {
      await session.newThread();
      updateSessionMetadata(contextKey, session);
      return true;
    } catch (error) {
      await safeReply(ctx, escapeHTML(`Failed to create session: ${friendlyErrorText(error)}`), {
        fallbackText: `Failed to create session: ${friendlyErrorText(error)}`,
      });
      return false;
    }
  };

  const handleUserPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: CodexSessionService,
    userInput: CodexPromptInput,
  ): Promise<void> => {
    const parsed = parseContextKey(contextKey);
    const messageThreadId = parsed.messageThreadId;

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.processing = true;

    const abortKeyboard = new InlineKeyboard().text("⏹ Abort", `codex_abort:${contextKey}`);
    const toolVerbosity: ToolVerbosity = config.toolVerbosity;
    const toolStates = new Map<string, ToolState>();
    const toolCounts = new Map<string, number>();
    let accumulatedText = "";
    let responseMessageId: number | undefined;
    let responseMessagePromise: Promise<void> | undefined;
    let lastRenderedText = "";
    let lastEditAt = 0;
    let flushTimer: NodeJS.Timeout | undefined;
    let isFlushing = false;
    let flushPending = false;
    let finalized = false;
    let planMessageId: number | undefined;
    let lastRenderedPlan = "";
    let planMessageSending = false;
    let lastTurnUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;

    const typingInterval = setInterval(() => {
      void bot.api
        .sendChatAction(chatId, "typing", {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        })
        .catch(() => {});
    }, TYPING_INTERVAL_MS);
    void bot.api
      .sendChatAction(chatId, "typing", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {});

    const stopTyping = (): void => {
      clearInterval(typingInterval);
    };

    const clearFlushTimer = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    };

    const renderPreview = (): RenderedChunk => {
      const previewText = buildStreamingPreview(accumulatedText);
      return renderMarkdownChunkWithinLimit(previewText);
    };

    const buildFinalResponseText = (text: string): string => {
      const trimmedText = text.trim();
      const usageLine =
        config.showTurnTokenUsage && lastTurnUsage ? formatTurnUsageLine(lastTurnUsage) : "";

      if (toolVerbosity === "summary") {
        const footerLines = [formatToolSummaryLine(toolCounts), usageLine].filter((line): line is string => Boolean(line));
        if (footerLines.length === 0) {
          return trimmedText;
        }

        const footer = footerLines.join("\n");
        return trimmedText ? `${trimmedText}\n\n${footer}` : footer;
      }

      if (toolVerbosity === "all" && usageLine) {
        return trimmedText ? `${trimmedText}\n\n${usageLine}` : usageLine;
      }

      return trimmedText;
    };

    const ensureResponseMessage = async (): Promise<void> => {
      if (responseMessageId) {
        return;
      }
      if (responseMessagePromise) {
        await responseMessagePromise;
        return;
      }

      responseMessagePromise = (async () => {
        stopTyping();
        const preview = renderPreview();
        const message = await sendTextMessage(bot.api, chatId, preview.text, {
          parseMode: preview.parseMode,
          fallbackText: preview.fallbackText,
          replyMarkup: abortKeyboard,
          messageThreadId,
        });
        responseMessageId = message.message_id;
        lastRenderedText = preview.text;
        lastEditAt = Date.now();
      })();

      try {
        await responseMessagePromise;
      } finally {
        responseMessagePromise = undefined;
      }
    };

    const flushResponse = async (force = false): Promise<void> => {
      if (!accumulatedText) {
        return;
      }
      if (!responseMessageId) {
        await ensureResponseMessage();
        return;
      }
      if (isFlushing) {
        flushPending = true;
        return;
      }

      const now = Date.now();
      if (!force && now - lastEditAt < EDIT_DEBOUNCE_MS) {
        return;
      }

      const nextText = renderPreview();
      if (nextText.text === lastRenderedText) {
        return;
      }

      isFlushing = true;
      try {
        await safeEditMessage(bot, chatId, responseMessageId, nextText.text, {
          parseMode: nextText.parseMode,
          fallbackText: nextText.fallbackText,
          replyMarkup: abortKeyboard,
        });
        lastRenderedText = nextText.text;
        lastEditAt = Date.now();
      } finally {
        isFlushing = false;
        if (flushPending) {
          flushPending = false;
          scheduleFlush();
        }
      }
    };

    const scheduleFlush = (): void => {
      if (flushTimer || finalized) {
        return;
      }

      const delay = Math.max(0, EDIT_DEBOUNCE_MS - (Date.now() - lastEditAt));
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushResponse().catch((error) => {
          console.error("Failed to update Telegram response message", error);
        });
      }, delay);
    };

    const removeAbortKeyboard = async (): Promise<void> => {
      if (!responseMessageId) {
        return;
      }

      try {
        await bot.api.editMessageReplyMarkup(chatId, responseMessageId, {
          reply_markup: new InlineKeyboard(),
        });
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error("Failed to clear Abort button", error);
        }
      }
    };

    const deliverRenderedChunks = async (chunks: RenderedChunk[]): Promise<void> => {
      if (chunks.length === 0) {
        return;
      }

      const [firstChunk, ...remainingChunks] = chunks;
      if (responseMessageId) {
        await safeEditMessage(bot, chatId, responseMessageId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
        });
        await removeAbortKeyboard();
      } else {
        const message = await sendTextMessage(bot.api, chatId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
          messageThreadId,
        });
        responseMessageId = message.message_id;
      }

      for (const chunk of remainingChunks) {
        await sendTextMessage(bot.api, chatId, chunk.text, {
          parseMode: chunk.parseMode,
          fallbackText: chunk.fallbackText,
          messageThreadId,
        });
      }
    };

    const finalizeResponse = async (): Promise<void> => {
      if (finalized) {
        return;
      }
      finalized = true;

      stopTyping();
      clearFlushTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // If the initial send failed, we will fall back to sending the final response below.
        }
      }

      const finalText = buildFinalResponseText(accumulatedText);
      if (!finalText) {
        const html = "<b>✅ Done</b>";
        const plainText = "✅ Done";

        if (responseMessageId) {
          await safeEditMessage(bot, chatId, responseMessageId, html, { fallbackText: plainText });
          await removeAbortKeyboard();
        } else {
          await safeReply(ctx, html, { fallbackText: plainText });
        }
        return;
      }

      await deliverRenderedChunks(splitMarkdownForTelegram(finalText));
    };

    const callbacks: CodexSessionCallbacks = {
      onTextDelta: (delta: string) => {
        accumulatedText += delta;
        if (!responseMessageId) {
          void ensureResponseMessage()
            .then(() => {
              scheduleFlush();
            })
            .catch((error) => {
              console.error("Failed to send initial Telegram response message", error);
            });
          return;
        }

        scheduleFlush();
      },
      onToolStart: (toolName: string, toolCallId: string) => {
        if (toolVerbosity === "summary") {
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
          return;
        }

        if (toolVerbosity === "none") {
          return;
        }

        toolStates.set(toolCallId, { toolName, partialResult: "" });
        if (toolVerbosity !== "all") {
          return;
        }

        const messageText = renderToolStartMessage(toolName);

        void (async () => {
          const message = await sendTextMessage(bot.api, chatId, messageText.text, {
            parseMode: messageText.parseMode,
            fallbackText: messageText.fallbackText,
            messageThreadId,
          });
          const state = toolStates.get(toolCallId);
          if (!state) {
            return;
          }

          state.messageId = message.message_id;
          if (state.finalStatus) {
            await safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
              parseMode: state.finalStatus.parseMode,
              fallbackText: state.finalStatus.fallbackText,
            });
          }
        })().catch((error) => {
          console.error(`Failed to send tool start message for ${toolName}`, error);
        });
      },
      onToolUpdate: (toolCallId: string, partialResult: string) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state || !partialResult) {
          return;
        }

        state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
      },
      onToolEnd: (toolCallId: string, isError: boolean) => {
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state) {
          return;
        }

        state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);
        if (toolVerbosity === "errors-only") {
          if (!isError) {
            return;
          }

          void sendTextMessage(bot.api, chatId, state.finalStatus.text, {
            parseMode: state.finalStatus.parseMode,
            fallbackText: state.finalStatus.fallbackText,
            messageThreadId,
          }).catch((error) => {
            console.error(`Failed to send tool error message for ${state.toolName}`, error);
          });
          return;
        }

        if (!state.messageId) {
          return;
        }

        void safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
          parseMode: state.finalStatus.parseMode,
          fallbackText: state.finalStatus.fallbackText,
        }).catch((error) => {
          console.error(`Failed to update tool message for ${state.toolName}`, error);
        });
      },
      onTodoUpdate: (items) => {
        if (toolVerbosity === "none") {
          return;
        }

        const rendered = renderTodoList(items);
        if (rendered === lastRenderedPlan) {
          return;
        }

        lastRenderedPlan = rendered;
        if (!planMessageId) {
          if (planMessageSending) return;
          planMessageSending = true;
          void sendTextMessage(bot.api, chatId, rendered, { parseMode: "HTML", messageThreadId })
            .then((msg) => {
              planMessageId = msg.message_id;
            })
            .catch((err) => {
              console.error("Failed to send plan message", err);
            })
            .finally(() => {
              planMessageSending = false;
            });
        } else {
          void safeEditMessage(bot, chatId, planMessageId, rendered, { parseMode: "HTML" }).catch((err) => {
            console.error("Failed to update plan message", err);
          });
        }
      },
      onTurnComplete: (usage) => {
        lastTurnUsage = usage;
      },
      onUserInputRequest: (request) => {
        const rendered = renderUserInputRequest(request);
        void safeReply(ctx, rendered.html, {
          fallbackText: rendered.plain,
        }).catch((error) => {
          console.error("Failed to send Codex input request", error);
        });
      },
      onAgentEnd: () => {
        void finalizeResponse().catch((error) => {
          console.error("Failed to finalize Telegram response message", error);
        });
      },
    };

    try {
      const authStatus = await checkAuthStatus(config.codexApiKey);
      if (!authStatus.authenticated) {
        await safeReply(
          ctx,
          [
            "<b>⚠️ Codex is not authenticated.</b>",
            "",
            `<code>${escapeHTML(authStatus.detail)}</code>`,
            "",
            "Use /login to start authentication, or set CODEX_API_KEY on the host.",
          ].join("\n"),
          {
            fallbackText: [
              "⚠️ Codex is not authenticated.",
              "",
              authStatus.detail,
              "",
              "Use /login to start authentication, or set CODEX_API_KEY on the host.",
            ].join("\n"),
          },
        );
        return;
      }

      if (!(await ensureActiveThread(ctx, contextKey, session))) {
        return;
      }

      await session.prompt(userInput, callbacks);
      updateSessionMetadata(contextKey, session);
      await finalizeResponse();
    } catch (error) {
      const currentModel = session.getInfo().model;
      const fallbackModel = config.codexModel;
      const hasVisibleOutput =
        accumulatedText.trim().length > 0 || toolStates.size > 0 || Boolean(lastTurnUsage);

      if (fallbackModel && shouldRetryWithFallbackModel(error, currentModel, fallbackModel, hasVisibleOutput)) {
        session.setModel(fallbackModel);
        updateSessionMetadata(contextKey, session);
        await safeReply(
          ctx,
          [
            "<b>Model fallback:</b>",
            "",
            `The active model <code>${escapeHTML(currentModel ?? "(unknown)")}</code> needs a newer Codex version on this host.`,
            `Retrying with <code>${escapeHTML(fallbackModel)}</code>.`,
          ].join("\n"),
          {
            fallbackText: [
              "Model fallback:",
              "",
              `The active model ${currentModel ?? "(unknown)"} needs a newer Codex version on this host.`,
              `Retrying with ${fallbackModel}.`,
            ].join("\n"),
          },
        );

        await session.prompt(userInput, callbacks);
        updateSessionMetadata(contextKey, session);
        await finalizeResponse();
        return;
      }

      stopTyping();
      clearFlushTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // Ignore; we will send an error message below.
        }
      }

      if (finalized) {
        console.error("Codex prompt error after finalization:", formatError(error));
      } else {
        finalized = true;

        const combinedText = buildFinalResponseText(renderPromptFailure(accumulatedText, error));
        const chunks = splitMarkdownForTelegram(combinedText);
        try {
          await deliverRenderedChunks(chunks);
        } catch (telegramError) {
          console.error("Failed to send error message to Telegram:", telegramError);
        }
      }
    } finally {
      stopTyping();
      clearFlushTimer();
      busyState.processing = false;
    }
  };

  const deliverArtifacts = async (
    ctx: Context,
    chatId: TelegramChatId,
    outDir: string,
    messageThreadId?: number,
  ): Promise<void> => {
    const { artifacts, skippedCount } = await collectArtifactReport(outDir);

    if (artifacts.length === 0 && skippedCount === 0) {
      return;
    }

    if (!config.autoSendArtifacts) {
      await safeReply(ctx, "Generated files were not sent automatically.", {
        fallbackText: "Generated files were not sent automatically.",
      });
      return;
    }

    await ctx.api
      .sendChatAction(chatId, "upload_document", {
        ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
      })
      .catch(() => {});

    let failedCount = 0;
    for (const artifact of artifacts) {
      try {
        await ctx.api.sendDocument(chatId, new InputFile(artifact.localPath, artifact.name), {
          ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
        });
      } catch (error) {
        failedCount += 1;
        console.error("Failed to send artifact:", formatLogError(error));
      }
    }

    const summary = formatArtifactSummary(artifacts, skippedCount + failedCount);
    if (summary) {
      await safeReply(ctx, escapeHTML(summary), { fallbackText: summary });
    }
  };

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!fromId || !config.telegramAllowedUserIdSet.has(fromId)) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Unauthorized" }).catch(() => {});
      } else if (ctx.chat) {
        await safeReply(ctx, escapeHTML("Unauthorized"), { fallbackText: "Unauthorized" });
      }
      return;
    }

    const chat = ctx.chat;
    if (chat && chat.type !== "private") {
      if (!config.enableGroupChats) {
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({ text: "Group chats are disabled" }).catch(() => {});
        } else {
          await safeReply(ctx, escapeHTML("Group chats are disabled for this bot."), {
            fallbackText: "Group chats are disabled for this bot.",
          });
        }
        return;
      }

      if (!config.telegramAllowedChatIdSet.has(chat.id)) {
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({ text: "Unauthorized chat" }).catch(() => {});
        } else {
          await safeReply(ctx, escapeHTML("This chat is not allowlisted."), {
            fallbackText: "This chat is not allowlisted.",
          });
        }
        return;
      }
    }

    await next();
  });

  bot.command("start", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const authStatus = await checkAuthStatus(config.codexApiKey);
    const authWarning = authStatus.authenticated ? undefined : "Not authenticated. Use /login or set CODEX_API_KEY.";
    const isReturning = registry.hasMetadata(contextKey);

    if (isReturning) {
      const info = session.getInfo();
      const welcome = renderWelcomeReturning(
        renderSessionInfoHTML(info),
        renderSessionInfoPlain(info),
        isTopicContext(contextKey),
        authWarning,
      );
      await safeReply(ctx, welcome.html, { fallbackText: welcome.plain });
    } else {
      const welcome = renderWelcomeFirstTime(authWarning);
      const info = session.getInfo();
      await safeReply(ctx, [welcome.html, "", renderLaunchSummaryHTML(info)].join("\n"), {
        fallbackText: [welcome.plain, "", renderLaunchSummaryPlain(info)].join("\n"),
      });
    }
  });

  bot.command("help", async (ctx) => {
    const help = renderHelpMessage();
    await safeReply(ctx, help.html, { fallbackText: help.plain });
  });

  bot.command("auth", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    const icon = authStatus.authenticated ? "✅" : "❌";
    const html = [
      `<b>${icon} Auth status:</b> ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `<b>Method:</b> <code>${escapeHTML(authStatus.method)}</code>`,
    ].join("\n");
    const plain = [
      `${icon} Auth status: ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `Method: ${authStatus.method}`,
    ].join("\n");

    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("login", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    if (ctx.chat.type !== "private") {
      await safeReply(ctx, escapeHTML("Login can only be started in a private chat."), {
        fallbackText: "Login can only be started in a private chat.",
      });
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.authenticated) {
      await safeReply(ctx, `<b>✅ Already authenticated</b> via <code>${escapeHTML(authStatus.method)}</code>.`, {
        fallbackText: `✅ Already authenticated via ${authStatus.method}.`,
      });
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(
        ctx,
        [
          "<b>Telegram-initiated login is disabled.</b>",
          "",
          "Run <code>codex login</code> on the host, or set CODEX_API_KEY in .env.",
        ].join("\n"),
        {
          fallbackText: [
            "Telegram-initiated login is disabled.",
            "",
            "Run 'codex login' on the host, or set CODEX_API_KEY in .env.",
          ].join("\n"),
        },
      );
      return;
    }

    const result = await startLogin();
    if (result.success) {
      await safeReply(ctx, `<b>🔑 Login initiated.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
        fallbackText: `🔑 Login initiated.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Login failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Login failed.\n\n${result.message}`,
    });
  });

  bot.command("logout", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    if (ctx.chat.type !== "private") {
      await safeReply(ctx, escapeHTML("Logout can only be started in a private chat."), {
        fallbackText: "Logout can only be started in a private chat.",
      });
      return;
    }

    const authStatus = await checkAuthStatus(config.codexApiKey);
    if (authStatus.method === "api-key") {
      await safeReply(
        ctx,
        [
          "<b>Cannot logout via Telegram when using CODEX_API_KEY.</b>",
          "",
          "Remove CODEX_API_KEY from .env to use CLI-based auth instead.",
        ].join("\n"),
        {
          fallbackText: [
            "Cannot logout via Telegram when using CODEX_API_KEY.",
            "",
            "Remove CODEX_API_KEY from .env to use CLI-based auth instead.",
          ].join("\n"),
        },
      );
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(ctx, [
        "<b>Telegram-initiated auth management is disabled.</b>",
        "",
        "Run <code>codex logout</code> on the host.",
      ].join("\n"), {
        fallbackText: [
          "Telegram-initiated auth management is disabled.",
          "",
          "Run 'codex logout' on the host.",
        ].join("\n"),
      });
      return;
    }

    if (!authStatus.authenticated) {
      await safeReply(ctx, escapeHTML("Not currently authenticated."), {
        fallbackText: "Not currently authenticated.",
      });
      return;
    }

    const result = await startLogout();
    if (result.success) {
      await safeReply(ctx, `<b>🔓 Logged out.</b>\n\n${escapeHTML(result.message)}`, {
        fallbackText: `🔓 Logged out.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Logout failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Logout failed.\n\n${result.message}`,
    });
  });

  bot.command("voice", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    if (!config.enableVoiceInput) {
      await safeReply(ctx, escapeHTML("Voice input is disabled. Send text instead."), {
        fallbackText: "Voice input is disabled. Send text instead.",
      });
      return;
    }

    const backends = await getAvailableBackends().catch(() => []);

    if (backends.length === 0) {
      await safeReply(
        ctx,
        [
          "<b>Voice transcription is not available.</b>",
          "",
          "Install <code>parakeet-coreml</code> + ffmpeg, or set <code>OPENAI_API_KEY</code>.",
          "<i>Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.</i>",
        ].join("\n"),
        {
          fallbackText: [
            "Voice transcription is not available.",
            "",
            "Install parakeet-coreml + ffmpeg, or set OPENAI_API_KEY.",
            "Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.",
          ].join("\n"),
        },
      );
      return;
    }

    const joined = backends.join(" + ");
    await safeReply(ctx, `<b>Voice backends:</b> <code>${escapeHTML(joined)}</code>`, {
      fallbackText: `Voice backends: ${joined}`,
    });
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot create a new session while a prompt is running."), {
        fallbackText: "Cannot create a new session while a prompt is running.",
      });
      return;
    }

    const workspaces = session.listWorkspaces();
    if (workspaces.length <= 1) {
      try {
        const info = await session.newThread();
        updateSessionMetadata(contextKey, session);
        const label = isTopicContext(contextKey) ? "New session created for this topic." : "New session created.";
        const plainText = `${label}\n\n${renderSessionInfoPlain(info)}`;
        const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`;
        await safeReply(ctx, html, { fallbackText: plainText });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    pendingWorkspacePicks.set(contextKey, workspaces);
    const currentWorkspace = session.getCurrentWorkspace();
    const workspaceButtons = workspaces.map((workspace, index) => ({
      label: `${workspace === currentWorkspace ? "📂" : "📁"} ${formatWorkspacePickerName(workspace, index, workspaces)}`,
      callbackData: `ws_${index}`,
    }));
    pendingWorkspaceButtons.set(contextKey, workspaceButtons);
    const keyboard = paginateKeyboard(workspaceButtons, 0, "ws");

    await safeReply(ctx, "<b>Select project for new session:</b>", {
      fallbackText: "Select project for new session:",
      replyMarkup: keyboard,
    });
  });

  bot.command("abort", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { session } = contextSession;
    try {
      await session.abort();
      await safeReply(ctx, escapeHTML("Aborted current operation"), {
        fallbackText: "Aborted current operation",
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("retry", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const cached = lastPromptInput.get(contextKey);
    if (!cached) {
      await safeReply(ctx, escapeHTML("Nothing to retry. Send a message first."), {
        fallbackText: "Nothing to retry. Send a message first.",
      });
      return;
    }

    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, cached);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.command("session", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const contextLabel = isTopicContext(contextKey) ? "Topic session" : "Chat session";

    const plainLines = [`${contextLabel}:`, renderSessionInfoPlain(info)];
    const htmlLines = [`<b>${escapeHTML(contextLabel)}:</b>`, renderSessionInfoHTML(info)];

    await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
  });

  bot.command("status", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { session } = contextSession;
    try {
      const snapshot = await session.getStatusSnapshot();
      const rendered = renderStatusSnapshot(snapshot, {
        includeAssistantOutput: config.showAssistantOutputInTelegram,
        includeErrorDetails: config.showErrorDetailsInTelegram,
      });
      await safeReply(ctx, rendered.text, {
        fallbackText: rendered.fallbackText,
        parseMode: rendered.parseMode,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("active", async (ctx) => {
    try {
      const active = await threadWatcher.listActiveCandidates();
      const rendered = renderActiveThreads(active);
      await safeReply(ctx, rendered.text, {
        fallbackText: rendered.fallbackText,
        parseMode: rendered.parseMode,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("watch", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    const argument = (ctx.message?.text ?? "").replace(/^\/watch(?:@\w+)?\s*/i, "").trim();
    if (argument) {
      try {
        const watch = await threadWatcher.addWatch(contextKey, argument);
        const rendered = renderWatchAdded(watch);
        await safeReply(ctx, rendered.text, {
          fallbackText: rendered.fallbackText,
          parseMode: rendered.parseMode,
        });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    try {
      const active = await threadWatcher.listActiveCandidates();
      if (active.length === 0) {
        await safeReply(ctx, "No active Codex sessions found right now.", {
          fallbackText: "No active Codex sessions found right now.",
        });
        return;
      }

      const buttons = active.map((snapshot, index) => ({
        label: formatWatchPickerLabel(snapshot),
        callbackData: `watch_${index}`,
      }));
      pendingWatchPicks.set(contextKey, active.map((snapshot) => snapshot.threadId));
      pendingWatchButtons.set(contextKey, buttons);

      await safeReply(ctx, "<b>Active Codex sessions:</b>\nTap one to watch it.", {
        fallbackText: "Active Codex sessions:\nTap one to watch it.",
        replyMarkup: paginateKeyboard(buttons, 0, "watch"),
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("watches", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    try {
      const rendered = renderWatches(await threadWatcher.refreshWatches(contextKey));
      await safeReply(ctx, rendered.text, {
        fallbackText: rendered.fallbackText,
        parseMode: rendered.parseMode,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("unwatch", async (ctx) => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return;
    }

    const argument = (ctx.message?.text ?? "").replace(/^\/unwatch(?:@\w+)?\s*/i, "").trim();
    const watches = threadWatcher.listWatches(contextKey);
    if (watches.length === 0) {
      await safeReply(ctx, "No watched Codex sessions in this chat.", {
        fallbackText: "No watched Codex sessions in this chat.",
      });
      return;
    }

    if (argument.toLowerCase() === "all") {
      const count = threadWatcher.removeAllForContext(contextKey);
      await safeReply(ctx, escapeHTML(`Removed ${count} watch${count === 1 ? "" : "es"}.`), {
        fallbackText: `Removed ${count} watch${count === 1 ? "" : "es"}.`,
      });
      return;
    }

    if (argument) {
      const removed = threadWatcher.removeWatch(contextKey, argument);
      await safeReply(ctx, escapeHTML(removed ? "Watch removed." : "No matching watch found."), {
        fallbackText: removed ? "Watch removed." : "No matching watch found.",
      });
      return;
    }

    if (watches.length === 1) {
      threadWatcher.removeWatch(contextKey, watches[0]!.threadId);
      await safeReply(ctx, "Watch removed.", { fallbackText: "Watch removed." });
      return;
    }

    const buttons = watches.map((watch, index) => ({
      label: formatWatchRecordLabel(watch),
      callbackData: `unwatch_${index}`,
    }));
    pendingUnwatchPicks.set(contextKey, watches.map((watch) => watch.threadId));
    pendingUnwatchButtons.set(contextKey, buttons);

    await safeReply(ctx, "<b>Watched Codex sessions:</b>\nTap one to remove it.", {
      fallbackText: "Watched Codex sessions:\nTap one to remove it.",
      replyMarkup: paginateKeyboard(buttons, 0, "unwatch"),
    });
  });

  bot.command(["usage", "cost"], async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const argument = (ctx.message?.text ?? "").replace(/^\/(?:usage|cost)(?:@\w+)?\s*/i, "").trim();
    const authStatus = await checkAuthStatus(config.codexApiKey);

    if (argument) {
      const workspace = resolveUsageWorkspace(argument, config);
      if (!workspace) {
        await safeReply(ctx, `<b>No matching project:</b> <code>${escapeHTML(argument)}</code>`, {
          fallbackText: `No matching project: ${argument}`,
        });
        return;
      }

      const workspaceUsage = summarizeWorkspaceUsage(workspace);
      if (!workspaceUsage) {
        await safeReply(ctx, "<b>No usage found.</b> Start or resume a session in this project first.", {
          fallbackText: "No usage found. Start or resume a session in this project first.",
        });
        return;
      }

      const rendered = renderUsageSummary(workspaceUsage, activeThreadIdForUsage(info, workspaceUsage), authStatus.method);
      await safeReply(ctx, rendered.text, {
        fallbackText: rendered.fallbackText,
        parseMode: rendered.parseMode,
      });
      return;
    }

    const usageWorkspaces = listUsageWorkspaceSummaries(config);
    if (usageWorkspaces.length > 1) {
      const buttons = usageWorkspaces.map((summary, index) => ({
        label: formatUsageWorkspaceLabel(summary, index),
        callbackData: `usage_${index}`,
      }));
      pendingUsagePicks.set(
        contextKey,
        usageWorkspaces.map((summary) => summary.workspace),
      );
      pendingUsageButtons.set(contextKey, buttons);

      await safeReply(ctx, "<b>Choose usage project:</b>", {
        fallbackText: "Choose usage project:",
        replyMarkup: paginateKeyboard(buttons, 0, "usage"),
      });
      return;
    }

    const workspaceUsage = usageWorkspaces[0] ?? summarizeWorkspaceUsage(info.workspace);
    if (!workspaceUsage) {
      await safeReply(ctx, "<b>No usage found.</b> Start or resume a session in this project first.", {
        fallbackText: "No usage found. Start or resume a session in this project first.",
      });
      return;
    }

    const rendered = renderUsageSummary(workspaceUsage, activeThreadIdForUsage(info, workspaceUsage), authStatus.method);
    await safeReply(ctx, rendered.text, {
      fallbackText: rendered.fallbackText,
      parseMode: rendered.parseMode,
    });
  });

  bot.command(["limits", "ratelimit"], async (ctx) => {
    const summary = getLatestRateLimitSummary();
    if (!summary) {
      await safeReply(ctx, "No rate-limit snapshot found yet.", {
        fallbackText: "No rate-limit snapshot found yet.",
      });
      return;
    }

    const rendered = renderRateLimitSummary(summary);
    await safeReply(ctx, rendered.text, {
      fallbackText: rendered.fallbackText,
      parseMode: rendered.parseMode,
    });
  });

  const openLaunchProfilesPicker = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change launch profile while a prompt is running."), {
        fallbackText: "Cannot change launch profile while a prompt is running.",
      });
      return;
    }

    const info = session.getInfo();
    const selectedLaunchProfile = session.getSelectedLaunchProfile();
    const launchButtons = config.launchProfiles.map((profile, index) => ({
      label: formatLaunchProfileLabelForTelegram(profile, profile.id === selectedLaunchProfile.id),
      callbackData: `launch_${index}`,
    }));

    pendingLaunchPicks.set(
      contextKey,
      config.launchProfiles.map((profile) => profile.id),
    );
    pendingLaunchButtons.set(contextKey, launchButtons);
    pendingUnsafeLaunchConfirmations.delete(contextKey);

    const keyboard = paginateKeyboard(launchButtons, 0, "launch");
    const htmlLines = [
      `<b>Selected launch profile:</b> <code>${escapeHTML(selectedLaunchProfile.label)}</code>`,
      `<b>Access:</b> <code>${escapeHTML(formatLaunchProfileBehaviorForTelegram(selectedLaunchProfile))}</code>`,
      "",
      "Select a profile for new or reattached sessions:",
    ];
    const plainLines = [
      `Selected launch profile: ${selectedLaunchProfile.label}`,
      `Access: ${formatLaunchProfileBehaviorForTelegram(selectedLaunchProfile)}`,
      "",
      "Select a profile for new or reattached sessions:",
    ];

    if (selectedLaunchProfile.unsafe) {
      htmlLines.splice(2, 0, "⚠️ <i>Selected profile uses full filesystem access.</i>");
      plainLines.splice(2, 0, "⚠️ Selected profile uses full filesystem access.");
    }

    if (info.nextLaunchProfileId) {
      htmlLines.splice(2, 0, `<b>Current session still uses:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`);
      plainLines.splice(2, 0, `Current session still uses: ${info.launchProfileLabel}`);
    }

    await safeReply(ctx, htmlLines.join("\n"), {
      fallbackText: plainLines.join("\n"),
      replyMarkup: keyboard,
    });
  };

  bot.command(["launch", "launch_profiles"], openLaunchProfilesPicker);
  bot.hears(/^\/launch-profiles(?:@\w+)?$/i, openLaunchProfilesPicker);

  bot.command("handback", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot resume locally while a prompt is running. Use /abort first."), {
        fallbackText: "Cannot resume locally while a prompt is running. Use /abort first.",
      });
      return;
    }

    if (!session.hasActiveThread()) {
      await safeReply(ctx, escapeHTML("No active session to resume locally."), {
        fallbackText: "No active session to resume locally.",
      });
      return;
    }

    try {
      const info = session.handback();
      updateSessionMetadata(contextKey, session);

      if (!info.threadId) {
        await safeReply(
          ctx,
          escapeHTML(
            "This session has not started yet. Send a message to create one, or use /new to start fresh.",
          ),
          {
            fallbackText:
              "This session has not started yet. Send a message to create one, or use /new to start fresh.",
          },
        );
        return;
      }

      const plainText = [
        "Session ready to resume locally.",
        "",
        "Open Codex on this machine and resume it from the local session list.",
        "Send any message here to start a new Telegram session instead.",
      ].join("\n");

      const html = [
        "<b>Session ready to resume locally.</b>",
        "",
        "Open Codex on this machine and resume it from the local session list.",
        "Send any message here to start a new Telegram session instead.",
      ].join("\n");

      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("attach", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot attach while a prompt is running."), {
        fallbackText: "Cannot attach while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/attach(?:@\w+)?\s*/, "").trim();

    if (!threadId) {
      await safeReply(ctx, escapeHTML("Usage: /attach <session-id>"), {
        fallbackText: "Usage: /attach <session-id>",
      });
      return;
    }

    if (!getThread(threadId)) {
      await safeReply(ctx, "<b>Failed:</b> Unknown Codex session.", {
        fallbackText: "Failed: Unknown Codex session.",
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Attached.</b>\n\n${renderSessionInfoHTML(info)}`;
      const plain = `Attached.\n\n${renderSessionInfoPlain(info)}`;
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command(["sessions", "switch"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot switch sessions while a prompt is running."), {
        fallbackText: "Cannot switch sessions while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const rawArgument = rawText.replace(/^\/(?:sessions|switch)(?:@\w+)?\s*/, "").trim();
    const listMode = rawArgument ? parseSessionListMode(rawArgument) : "main";
    const threadId = listMode ? "" : rawArgument;

    if (threadId) {
      const busyState = getBusyState(contextKey);
      busyState.switching = true;
      try {
        const info = await session.switchSession(threadId);
        updateSessionMetadata(contextKey, session);
        const html = `<b>Switched session.</b>\n\n${renderSessionInfoHTML(info)}`;
        const plain = `Switched session.\n\n${renderSessionInfoPlain(info)}`;
        await safeReply(ctx, html, { fallbackText: plain });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      } finally {
        busyState.switching = false;
      }
      return;
    }

    const sessions = session.listAllSessions(50, {
      includeSubAgents: listMode === "all",
      onlySubAgents: listMode === "subagents",
    });
    if (sessions.length === 0) {
      const emptyText = `No recent ${formatSessionListModeLabel(listMode)} found.`;
      await safeReply(ctx, escapeHTML(emptyText), {
        fallbackText: emptyText,
      });
      return;
    }

    const groupedSessions = new Map<string, typeof sessions>();
    for (const listedSession of sessions) {
      const workspaceSessions = groupedSessions.get(listedSession.cwd);
      if (workspaceSessions) {
        workspaceSessions.push(listedSession);
      } else {
        groupedSessions.set(listedSession.cwd, [listedSession]);
      }
    }

    const orderedSessions: typeof sessions = [];

    for (const workspaceSessions of groupedSessions.values()) {
      orderedSessions.push(...workspaceSessions);
    }

    pendingSessionPicks.set(
      contextKey,
      orderedSessions.map((listedSession) => listedSession.id),
    );

    const activeThreadId = session.getInfo().threadId;
    const sessionButtons = orderedSessions.map((listedSession, index) => {
      return {
        label: formatSessionLabel({
          workspace: listedSession.cwd,
          title: listedSession.title || listedSession.firstUserMessage || "",
          relativeTime: formatRelativeTime(listedSession.updatedAt),
          model: listedSession.model || undefined,
          isActive: listedSession.id === activeThreadId,
          isSubAgent: Boolean(listedSession.isSubAgent),
          agentNickname: listedSession.agentNickname,
        }),
        callbackData: `sess_${index}`,
      };
    });
    pendingSessionButtons.set(contextKey, sessionButtons);
    const keyboard = paginateKeyboard(sessionButtons, 0, "sess");
    const heading = `Recent ${formatSessionListModeLabel(listMode)} (${orderedSessions.length}):\nTap to switch.`;

    await safeReply(ctx, `<b>${escapeHTML(heading)}</b>`, {
      fallbackText: heading,
      replyMarkup: keyboard,
    });
  });

  bot.command("model", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change model while a prompt is running."), {
        fallbackText: "Cannot change model while a prompt is running.",
      });
      return;
    }

    const models = session.listModels();
    if (models.length === 0) {
      await safeReply(ctx, escapeHTML("No models available."), {
        fallbackText: "No models available.",
      });
      return;
    }

    const currentModel = session.getInfo().model ?? "(default)";
    const modelButtons = models.map((model) => ({
      label: `${model.displayName}${model.slug === currentModel ? " ✓" : ""}`,
      callbackData: `model_${model.slug}`,
    }));
    pendingModelButtons.set(contextKey, modelButtons);
    const keyboard = paginateKeyboard(modelButtons, 0, "model");

    await safeReply(
      ctx,
      [`<b>Current model:</b> <code>${escapeHTML(currentModel)}</code>`, "", "Select a model for new sessions:"].join("\n"),
      {
        fallbackText: [`Current model: ${currentModel}`, "", "Select a model for new sessions:"].join("\n"),
        replyMarkup: keyboard,
      },
    );
  });

  bot.command("effort", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const efforts: ModelReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
    const current = session.getInfo().reasoningEffort;
    const effortButtons = efforts.map((effort) => ({
      label: effort === current ? `${effort} ✓` : effort,
      callbackData: `effort_${effort}`,
    }));
    pendingEffortButtons.set(contextKey, effortButtons);
    const keyboard = paginateKeyboard(effortButtons, 0, "effort");
    const text = current
      ? `<b>Reasoning effort:</b> <code>${escapeHTML(current)}</code>\n\nSelect for new sessions:`
      : "<b>Reasoning effort:</b> not set (model default)\n\nSelect for new sessions:";
    await safeReply(ctx, text, {
      fallbackText: text.replace(/<[^>]+>/g, ""),
      replyMarkup: keyboard,
    });
  });

  bot.callbackQuery(NOOP_PAGE_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
  });
  handlePageCallback(/^sess_page_(\d+)$/, "sess", pendingSessionButtons, "Expired, run /sessions again");
  handlePageCallback(/^ws_page_(\d+)$/, "ws", pendingWorkspaceButtons, "Expired, run /new again");
  handlePageCallback(
    /^launch_page_(\d+)$/,
    "launch",
    pendingLaunchButtons,
    `Expired, run ${LAUNCH_PROFILES_COMMAND} again`,
  );
  handlePageCallback(/^model_page_(\d+)$/, "model", pendingModelButtons, "Expired, run /model again");
  handlePageCallback(/^effort_page_(\d+)$/, "effort", pendingEffortButtons, "Expired, run /effort again");
  handlePageCallback(/^watch_page_(\d+)$/, "watch", pendingWatchButtons, "Expired, run /watch again");
  handlePageCallback(/^unwatch_page_(\d+)$/, "unwatch", pendingUnwatchButtons, "Expired, run /unwatch again");
  handlePageCallback(/^usage_page_(\d+)$/, "usage", pendingUsageButtons, "Expired, run /usage again");

  bot.callbackQuery(/^codex_abort:(.+)$/, async (ctx) => {
    const contextKey = ctx.match?.[1];
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }

    const session = registry.get(contextKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Nothing to abort" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Aborting..." });
    await session.abort();
  });

  bot.callbackQuery(/^watch_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const contextKey = contextKeyFromCtx(ctx);
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);
    if (!chatId || !contextKey || Number.isNaN(index)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const threadIds = pendingWatchPicks.get(contextKey);
    const threadId = threadIds?.[index];
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: "Expired, run /watch again" });
      return;
    }

    try {
      const watch = await threadWatcher.addWatch(contextKey, threadId);
      pendingWatchPicks.delete(contextKey);
      pendingWatchButtons.delete(contextKey);
      await ctx.answerCallbackQuery({ text: "Watching session" });
      const rendered = renderWatchAdded(watch);
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, rendered.text, {
          fallbackText: rendered.fallbackText,
          parseMode: rendered.parseMode,
        });
      } else {
        await safeReply(ctx, rendered.text, {
          fallbackText: rendered.fallbackText,
          parseMode: rendered.parseMode,
        });
      }
    } catch (error) {
      await ctx.answerCallbackQuery({ text: "Failed" }).catch(() => {});
      const rendered = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      if (messageId && chatId) {
        await safeEditMessage(bot, chatId, messageId, rendered, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      } else {
        await safeReply(ctx, rendered, { fallbackText: `Failed: ${friendlyErrorText(error)}` });
      }
    }
  });

  bot.callbackQuery(/^unwatch_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const contextKey = contextKeyFromCtx(ctx);
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);
    if (!chatId || !contextKey || Number.isNaN(index)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const threadIds = pendingUnwatchPicks.get(contextKey);
    const threadId = threadIds?.[index];
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: "Expired, run /unwatch again" });
      return;
    }

    const removed = threadWatcher.removeWatch(contextKey, threadId);
    pendingUnwatchPicks.delete(contextKey);
    pendingUnwatchButtons.delete(contextKey);
    await ctx.answerCallbackQuery({ text: removed ? "Watch removed" : "No matching watch" });
    const text = removed ? "Watch removed." : "No matching watch found.";
    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, escapeHTML(text), { fallbackText: text });
    } else {
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
    }
  });

  bot.callbackQuery(/^usage_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const contextKey = contextKeyFromCtx(ctx);
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);
    if (!chatId || !contextKey || Number.isNaN(index)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const workspaces = pendingUsagePicks.get(contextKey);
    const workspace = workspaces?.[index];
    if (!workspace) {
      await ctx.answerCallbackQuery({ text: "Expired, run /usage again" });
      return;
    }

    const workspaceUsage = summarizeWorkspaceUsage(workspace);
    if (!workspaceUsage) {
      await ctx.answerCallbackQuery({ text: "No usage found" });
      return;
    }

    pendingUsagePicks.delete(contextKey);
    pendingUsageButtons.delete(contextKey);
    await ctx.answerCallbackQuery({ text: "Usage selected" });
    const authStatus = await checkAuthStatus(config.codexApiKey);
    const rendered = renderUsageSummary(workspaceUsage, null, authStatus.method);
    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, rendered.text, {
        fallbackText: rendered.fallbackText,
        parseMode: rendered.parseMode,
      });
    } else {
      await safeReply(ctx, rendered.text, {
        fallbackText: rendered.fallbackText,
        parseMode: rendered.parseMode,
      });
    }
  });

  bot.callbackQuery(/^sess_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const threadIds = pendingSessionPicks.get(contextKey);
    const threadId = threadIds?.[index];
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: "Session expired, run /sessions again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching..." });
    pendingSessionPicks.delete(contextKey);
    pendingSessionButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      const plainText = `Switched session.\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>Switched session.</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^ws_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const workspaces = pendingWorkspacePicks.get(contextKey);
    const workspace = workspaces?.[index];
    if (!workspace) {
      await ctx.answerCallbackQuery({ text: "Expired, run /new again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Creating session..." });
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.newThread(workspace);
      updateSessionMetadata(contextKey, session);
      const label = isTopicContext(contextKey) ? "New session created for this topic." : "New session created.";
      const plainText = `${label}\n\n${renderSessionInfoPlain(info)}`;
      const html = `<b>${escapeHTML(label)}</b>\n\n${renderSessionInfoHTML(info)}`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^launch_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const launchProfileIds = pendingLaunchPicks.get(contextKey);
    const profileId = launchProfileIds?.[index];
    if (!profileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      return;
    }

    if (profile.unsafe) {
      pendingUnsafeLaunchConfirmations.set(contextKey, profile.id);
      pendingLaunchPicks.delete(contextKey);
      pendingLaunchButtons.delete(contextKey);

      await ctx.answerCallbackQuery({ text: "Confirm full access" });
      const confirmKeyboard = new InlineKeyboard()
        .text("Enable full filesystem access", `launchconfirm_yes:${profile.id}`)
        .row()
        .text("Cancel", `launchconfirm_no:${profile.id}`);
      const html = [
        `<b>Confirm launch profile:</b> <code>${escapeHTML(profile.label)}</code>`,
        `<b>Access:</b> <code>${escapeHTML(formatLaunchProfileBehaviorForTelegram(profile))}</code>`,
        "",
        "⚠️ <b>This profile uses full filesystem access.</b>",
        "It will apply to new or reattached sessions in this Telegram context.",
      ].join("\n");
      const plain = [
        `Confirm launch profile: ${profile.label}`,
        `Access: ${formatLaunchProfileBehaviorForTelegram(profile)}`,
        "",
        "WARNING: This profile uses full filesystem access.",
        "It will apply to new or reattached sessions in this Telegram context.",
      ].join("\n");

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      } else {
        await safeReply(ctx, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: `Launch set to ${profile.label}` });
    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);

    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>Access:</b> <code>${escapeHTML(formatLaunchProfileBehaviorForTelegram(selectedProfile))}</code>`,
      "",
      "Applies to new or reattached sessions.",
    ].join("\n");
    const plain = [
      `Launch profile set to ${selectedProfile.label}`,
      `Access: ${formatLaunchProfileBehaviorForTelegram(selectedProfile)}`,
      "",
      "Applies to new or reattached sessions.",
    ].join("\n");

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
    } else {
      await safeReply(ctx, html, { fallbackText: plain });
    }
  });

  bot.callbackQuery(/^launchconfirm_(yes|no):([a-z0-9_-]+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const action = ctx.match?.[1];
    const confirmedProfileId = ctx.match?.[2];

    if (!chatId || !messageId || !action || !confirmedProfileId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const profileId = pendingUnsafeLaunchConfirmations.get(contextKey);
    if (!profileId || profileId !== confirmedProfileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (action === "no") {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch change cancelled.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        {
          fallbackText: `Launch change cancelled.\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        },
      );
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = findLaunchProfile(config.launchProfiles, profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch profile expired.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        {
          fallbackText: `Launch profile expired.\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        },
      );
      return;
    }

    clearLaunchSelectionState(contextKey);
    const selectedProfile = session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);
    await ctx.answerCallbackQuery({ text: `Launch set to ${selectedProfile.label}` });

    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(selectedProfile.label)}</code>`,
      `<b>Access:</b> <code>${escapeHTML(formatLaunchProfileBehaviorForTelegram(selectedProfile))}</code>`,
      "",
      "⚠️ <i>Full filesystem access confirmed for new or reattached sessions.</i>",
    ].join("\n");
    const plain = [
      `Launch profile set to ${selectedProfile.label}`,
      `Access: ${formatLaunchProfileBehaviorForTelegram(selectedProfile)}`,
      "",
      "Full filesystem access confirmed for new or reattached sessions.",
    ].join("\n");

    await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
  });

  bot.callbackQuery(/^model_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const slug = ctx.match?.[1];

    if (!chatId || !slug) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingModelButtons.get(contextKey);
    if (!buttons) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    const modelExists = buttons.some((button) => button.callbackData === `model_${slug}`);
    if (!modelExists) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Setting model..." });
    pendingModelButtons.delete(contextKey);

    try {
      const model = session.setModel(slug);
      updateSessionMetadata(contextKey, session);
      const html = `<b>Model set to</b> <code>${escapeHTML(model)}</code> — applies to new sessions.`;
      const plainText = `Model set to ${model} — applies to new sessions.`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    }
  });

  bot.callbackQuery(/^effort_(minimal|low|medium|high|xhigh)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const effort = ctx.match?.[1] as ModelReasoningEffort | undefined;

    if (!chatId || !messageId || !effort) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingEffortButtons.get(contextKey);
    if (!buttons || !buttons.some((button) => button.callbackData === `effort_${effort}`)) {
      await ctx.answerCallbackQuery({ text: "Expired, run /effort again" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Effort set to ${effort}` });
    pendingEffortButtons.delete(contextKey);
    session.setReasoningEffort(effort);
    updateSessionMetadata(contextKey, session);
    const html = `⚡ Reasoning effort set to <code>${escapeHTML(effort)}</code> — applies to new sessions.`;
    await safeEditMessage(bot, chatId, messageId, html, {
      fallbackText: `⚡ Reasoning effort set to ${effort} — applies to new sessions.`,
    });
  });

  bot.command("answer", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { session } = contextSession;
    const answer = (ctx.message?.text ?? "").replace(/^\/answer(?:@\w+)?\s*/i, "").trim();
    if (!session.hasPendingUserInput()) {
      await safeReply(ctx, escapeHTML("No pending Codex question in this chat."), {
        fallbackText: "No pending Codex question in this chat.",
      });
      return;
    }

    if (!answer) {
      await safeReply(ctx, escapeHTML("Usage: /answer <your answer>"), {
        fallbackText: "Usage: /answer <your answer>",
      });
      return;
    }

    try {
      await session.answerPendingUserInput(answer);
      await safeReply(ctx, escapeHTML("Answer sent to Codex."), {
        fallbackText: "Answer sent to Codex.",
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("steer", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { session } = contextSession;
    const text = (ctx.message?.text ?? "").replace(/^\/steer(?:@\w+)?\s*/i, "").trim();
    if (!text) {
      await safeReply(ctx, escapeHTML("Usage: /steer <message for the active turn>"), {
        fallbackText: "Usage: /steer <message for the active turn>",
      });
      return;
    }

    try {
      await session.steerActiveTurn(text);
      await safeReply(ctx, escapeHTML("Steering message sent."), {
        fallbackText: "Steering message sent.",
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.on("message:text", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const userText = ctx.message.text.trim();
    if (!userText || userText.startsWith("/")) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (session.hasPendingUserInput()) {
      await setReaction(ctx, "👀");
      try {
        await session.answerPendingUserInput(userText);
        await safeReply(ctx, escapeHTML("Answer sent to Codex."), {
          fallbackText: "Answer sent to Codex.",
        });
        await setReaction(ctx, "👍");
      } catch (error) {
        await clearReaction(ctx);
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    lastPromptInput.set(contextKey, userText);
    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, ctx.chat.id, session, userText);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    if (!config.enableVoiceInput) {
      await safeReply(ctx, escapeHTML("Voice input is disabled. Send text instead."), {
        fallbackText: "Voice input is disabled. Send text instead.",
      });
      return;
    }

    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;
    let transcript: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId);

      const result = await transcribeAudio(tempFilePath);
      transcript = result.text.trim();
      if (!transcript) {
        await safeReply(ctx, escapeHTML("Transcription was empty. Please try again or send text instead."), {
          fallbackText: "Transcription was empty. Please try again or send text instead.",
        });
        return;
      }

      const preview = trimLine(transcript.replace(/\s+/g, " "), 100);
      await safeReply(
        ctx,
        `🎙️ <b>Transcribed:</b> ${escapeHTML(preview)} <i>(via ${escapeHTML(result.backend)})</i>`,
        { fallbackText: `🎙️ Transcribed: ${preview} (via ${result.backend})` },
      );
    } catch (error) {
      const note = "Note: voice transcription uses OPENAI_API_KEY, not CODEX_API_KEY.";
      await safeReply(ctx, `<b>Transcription failed:</b>\n${escapeHTML(friendlyErrorText(error))}\n\n<i>${escapeHTML(note)}</i>`, {
        fallbackText: `Transcription failed:\n${friendlyErrorText(error)}\n\n${note}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    if (!transcript) {
      return;
    }

    lastPromptInput.set(contextKey, transcript);
    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, transcript);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.on("message:photo", async (ctx) => {
    if (!config.enableFileUploads) {
      await safeReply(ctx, escapeHTML("Image input is disabled. Send text instead."), {
        fallbackText: "Image input is disabled. Send text instead.",
      });
      return;
    }

    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (!photo) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "upload_photo");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, photo.file_id, 20 * 1024 * 1024);
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download photo:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download photo: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (!tempFilePath) {
        // Download failed — nothing to clean up further
      }
    }

    const caption = ctx.message.caption?.trim();
    const promptInput: { text?: string; imagePaths: string[] } = { imagePaths: [tempFilePath] };
    if (caption) {
      promptInput.text = caption;
      lastPromptInput.set(contextKey, caption);
    }
    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, promptInput);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    } finally {
      await unlink(tempFilePath).catch(() => {});
    }
  });

  bot.on("message:document", async (ctx) => {
    if (!config.enableFileUploads) {
      await safeReply(ctx, escapeHTML("File uploads are disabled. Send text instead."), {
        fallbackText: "File uploads are disabled. Send text instead.",
      });
      return;
    }

    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;
    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const doc = ctx.message.document;
    if (!doc) {
      return;
    }

    if (doc.file_size && doc.file_size > config.maxFileSize) {
      const sizeMB = Math.round(doc.file_size / 1024 / 1024);
      const maxMB = Math.round(config.maxFileSize / 1024 / 1024);
      await safeReply(ctx, `<b>File too large</b> (${sizeMB} MB, max ${maxMB} MB)`, {
        fallbackText: `File too large (${sizeMB} MB, max ${maxMB} MB)`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await ctx.api.sendChatAction(chatId, "typing");
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, doc.file_id, config.maxFileSize);
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
    }

    const turnId = randomUUID().slice(0, 12);
    const workspace = session.getCurrentWorkspace();
    const originalName = doc.file_name ?? "document";
    const mimeType = doc.mime_type ?? "application/octet-stream";

    let stagedFile: StagedFile;
    try {
      const buffer = await readFile(tempFilePath);
      stagedFile = await stageFile(buffer, originalName, mimeType, {
        workspace,
        turnId,
        maxFileSize: config.maxFileSize,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed to stage file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to stage file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    await safeReply(ctx, `📎 <b>Received:</b> <code>${escapeHTML(stagedFile.safeName)}</code>`, {
      fallbackText: `📎 Received: ${stagedFile.safeName}`,
    });

    // Keep typing visible during the gap between staging and prompt execution
    await ctx.api.sendChatAction(chatId, "typing").catch(() => {});

    const outDir = outboxPath(workspace, turnId);
    await ensureOutDir(outDir);

    const promptInput: CodexPromptInput = {
      stagedFileInstructions: buildFileInstructions([stagedFile], outDir),
    };
    const caption = ctx.message.caption?.trim();
    if (caption) {
      promptInput.text = caption;
      lastPromptInput.set(contextKey, caption);
    }

    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, promptInput);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    } finally {
      try {
        await deliverArtifacts(ctx, chatId, outDir, parseContextKey(contextKey).messageThreadId);
      } catch (artifactError) {
        console.error("Failed to deliver artifacts:", formatLogError(artifactError));
      } finally {
        await cleanupInbox(workspace, turnId);
        // TODO: prune old outbox turn folders by age or count to avoid unbounded growth
      }
    }
  });

  bot.catch(async (error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    console.error("Telegram bot error:", formatLogError(message));

    if (!error.ctx?.chat) {
      return;
    }

    try {
      if (error.ctx.callbackQuery) {
        await error.ctx.answerCallbackQuery({ text: "Bridge error. Retry." }).catch(() => {});
      }

      await safeReply(error.ctx, "<b>Bridge error.</b>\n\nTry again.", {
        fallbackText: "Bridge error.\n\nTry again.",
      });
    } catch (replyError) {
      console.error("Failed to send Telegram error reply:", formatLogError(replyError));
    }
  });

  return bot;
}

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Welcome & status" },
    { command: "help", description: "Command reference" },
    { command: "new", description: "Start a new session" },
    { command: "session", description: "Current session" },
    { command: "status", description: "Check current status" },
    { command: "active", description: "List active Codex sessions" },
    { command: "watch", description: "Watch an active session" },
    { command: "watches", description: "List watched sessions" },
    { command: "unwatch", description: "Stop watching a session" },
    { command: "usage", description: "Token and cost totals" },
    { command: "limits", description: "Latest Codex rate limits" },
    { command: "sessions", description: "Browse & switch sessions" },
    { command: "abort", description: "Cancel current operation" },
    { command: "model", description: "View & change model" },
  ]);
}

function parseSessionListMode(argument: string): SessionListMode | null {
  const normalized = argument.trim().toLowerCase().replace(/^--/, "");

  switch (normalized) {
    case "":
    case "main":
    case "parents":
      return "main";
    case "all":
    case "with-subagents":
    case "with-related":
      return "all";
    case "related":
    case "background":
    case "subagents":
    case "sub-agents":
    case "subs":
      return "subagents";
    default:
      return null;
  }
}

function formatSessionListModeLabel(mode: SessionListMode | null): string {
  switch (mode) {
    case "all":
      return "sessions";
    case "subagents":
      return "related sessions";
    case "main":
    case null:
      return "main sessions";
  }
}

function renderUserInputRequest(request: PendingUserInputRequest): { html: string; plain: string } {
  const plainLines = [
    "Codex needs your input.",
    "",
    ...request.questions.flatMap((question, index) => {
      const lines = [`${index + 1}. ${question.header}: ${question.question}`];
      if (question.options?.length) {
        lines.push(
          ...question.options.map((option) =>
            option.description ? `   - ${option.label}: ${option.description}` : `   - ${option.label}`,
          ),
        );
      }
      return lines;
    }),
    "",
    request.questions.length > 1
      ? "Reply with one answer per line, or use /answer with one answer per line."
      : "Reply with the answer, or use /answer <answer>.",
  ];

  const htmlLines = [
    "<b>Codex needs your input.</b>",
    "",
    ...request.questions.flatMap((question, index) => {
      const lines = [
        `<b>${index + 1}. ${escapeHTML(question.header)}:</b> ${escapeHTML(question.question)}`,
      ];
      if (question.options?.length) {
        lines.push(
          ...question.options.map((option) =>
            option.description
              ? `- <code>${escapeHTML(option.label)}</code>: ${escapeHTML(option.description)}`
              : `- <code>${escapeHTML(option.label)}</code>`,
          ),
        );
      }
      return lines;
    }),
    "",
    request.questions.length > 1
      ? "Reply with one answer per line, or use <code>/answer</code> with one answer per line."
      : "Reply with the answer, or use <code>/answer &lt;answer&gt;</code>.",
  ];

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

function renderActiveThreads(active: ThreadStatusSnapshot[]): RenderedText {
  if (active.length === 0) {
    return {
      text: "No active Codex sessions found right now.",
      fallbackText: "No active Codex sessions found right now.",
      parseMode: "HTML",
    };
  }

  const plainLines = [`Active Codex sessions (${active.length}):`];
  const htmlLines = [`<b>Active Codex sessions (${active.length}):</b>`];

  for (const [index, snapshot] of active.entries()) {
    const title = trimLine(snapshot.title || "(untitled)", 60);
    const updated = snapshot.lastUpdatedAt ? formatRelativeTime(snapshot.lastUpdatedAt) : "unknown";
    const usage = summarizeThreadUsage(snapshot.workspace, snapshot.threadId);
    const stats = formatWatchStatsPlain({
      currentRoundMs: getSnapshotCurrentRoundDurationMs(snapshot),
      sessionWorkMs: usage?.estimatedActiveMs,
      totalTokens: usage?.totals.totalTokens,
      estimatedCostUsd: usage?.estimatedCostUsd,
    });
    const line = `${index + 1}. ${formatWatchState(snapshot.state)} | ${title} | ${updated}`;
    plainLines.push(line, `   ${stats}`);
    htmlLines.push(escapeHTML(line), `<code>${escapeHTML(stats)}</code>`);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

function renderWatchAdded(watch: WatchRecord): RenderedText {
  const title = watch.title || "(untitled)";
  const usage = summarizeThreadUsage(watch.workspace, watch.threadId);
  const stats = formatWatchStatsPlain({
    currentRoundMs: getWatchCurrentRoundDurationMs(watch),
    sessionWorkMs: usage?.estimatedActiveMs,
    totalTokens: usage?.totals.totalTokens,
    estimatedCostUsd: usage?.estimatedCostUsd,
  });
  const plain = [
    "Watching Codex session.",
    `State: ${formatWatchState(watch.lastState ?? "unknown")}`,
    `Title: ${title}`,
    `Stats: ${stats}`,
    "Notifications will include time, tokens, and cost when available.",
  ].join("\n");

  const html = [
    "<b>Watching Codex session.</b>",
    `<b>State:</b> <code>${escapeHTML(formatWatchState(watch.lastState ?? "unknown"))}</code>`,
    `<b>Title:</b> ${escapeHTML(title)}`,
    `<b>Stats:</b> <code>${escapeHTML(stats)}</code>`,
    "Notifications will include time, tokens, and cost when available.",
  ].join("\n");

  return { text: html, fallbackText: plain, parseMode: "HTML" };
}

function renderWatches(watches: WatchRecord[]): RenderedText {
  if (watches.length === 0) {
    return {
      text: "No watched Codex sessions in this chat.",
      fallbackText: "No watched Codex sessions in this chat.",
      parseMode: "HTML",
    };
  }

  const plainLines = [`Watched Codex sessions (${watches.length}):`];
  const htmlLines = [`<b>Watched Codex sessions (${watches.length}):</b>`];

  for (const [index, watch] of watches.entries()) {
    const title = trimLine(watch.title || "(untitled)", 60);
    const state = formatWatchState(watch.lastState ?? "unknown");
    const updated = watch.lastUpdatedAt ? formatRelativeTime(new Date(watch.lastUpdatedAt)) : "unknown";
    const usage = summarizeThreadUsage(watch.workspace, watch.threadId);
    const stats = formatWatchStatsPlain({
      currentRoundMs: getWatchCurrentRoundDurationMs(watch),
      sessionWorkMs: usage?.estimatedActiveMs,
      totalTokens: usage?.totals.totalTokens,
      estimatedCostUsd: usage?.estimatedCostUsd,
    });
    const line = `${index + 1}. ${state} | ${title} | ${updated}`;
    plainLines.push(line, `   ${stats}`);
    htmlLines.push(escapeHTML(line), `<code>${escapeHTML(stats)}</code>`);
  }

  return { text: htmlLines.join("\n"), fallbackText: plainLines.join("\n"), parseMode: "HTML" };
}

function renderWatchTransition(
  transition: WatchTransition,
  options: { includeAssistantOutput?: boolean; includeErrorDetails?: boolean } = {},
): RenderedText {
  const title = transition.current.title || transition.watch.title || "(untitled)";
  const state = formatWatchState(transition.current.state);
  const previous = transition.previousState ? formatWatchState(transition.previousState) : "unknown";
  const assistant = options.includeAssistantOutput && transition.current.latestAssistantMessage
    ? truncateStatusText(transition.current.latestAssistantMessage, 120)
    : undefined;
  const currentRoundMs = getSnapshotCurrentRoundDurationMs(transition.current);
  const currentRunLabel = currentRoundMs !== undefined ? formatElapsedDuration(currentRoundMs) : undefined;
  const usage = summarizeWatchedThreadUsage(transition);
  const shouldShowUsageMissing = transition.current.state === "idle" || transition.current.state === "failed";
  const costLabel = usage
    ? `${formatUsd(usage.estimatedCostUsd)}${usage.hasUnsupportedPricing ? " partial" : ""}`
    : undefined;
  const relatedLabel =
    usage && usage.subAgentCount > 0
      ? `Includes ${usage.subAgentCount} related task${usage.subAgentCount === 1 ? "" : "s"}.`
      : undefined;

  const plainLines = [
    "Codex session update:",
    `State: ${previous} -> ${state}`,
    `Title: ${title}`,
    currentRunLabel ? `Current run: ${currentRunLabel}` : undefined,
    usage ? `Total work: ${formatDuration(usage.estimatedActiveMs)}` : undefined,
    usage ? `Tokens: ${formatTotalsPlain(usage.totals)}` : undefined,
    usage ? `Cost: ${costLabel}` : undefined,
    relatedLabel,
    !usage && shouldShowUsageMissing ? "Session usage: not available yet." : undefined,
    transition.current.lastTurnError
      ? `Error: ${options.includeErrorDetails ? transition.current.lastTurnError : "details hidden by configuration"}`
      : undefined,
    assistant ? `Latest: ${assistant}` : undefined,
  ].filter((line): line is string => Boolean(line));

  const htmlLines = [
    "<b>Codex session update:</b>",
    `<b>State:</b> <code>${escapeHTML(previous)} -&gt; ${escapeHTML(state)}</code>`,
    `<b>Title:</b> ${escapeHTML(title)}`,
    currentRunLabel ? `<b>Current run:</b> <code>${escapeHTML(currentRunLabel)}</code>` : undefined,
    usage ? `<b>Total work:</b> <code>${escapeHTML(formatDuration(usage.estimatedActiveMs))}</code>` : undefined,
    usage ? `<b>Tokens:</b> <code>${escapeHTML(formatTotalsPlain(usage.totals))}</code>` : undefined,
    usage ? `<b>Cost:</b> <code>${escapeHTML(costLabel ?? "(unavailable)")}</code>` : undefined,
    relatedLabel ? escapeHTML(relatedLabel) : undefined,
    !usage && shouldShowUsageMissing ? "Session usage: not available yet." : undefined,
    transition.current.lastTurnError && options.includeErrorDetails
      ? `<b>Error:</b> <code>${escapeHTML(transition.current.lastTurnError)}</code>`
      : undefined,
    transition.current.lastTurnError && !options.includeErrorDetails
      ? "<b>Error:</b> <code>details hidden by configuration</code>"
      : undefined,
    assistant ? `<b>Latest:</b> ${escapeHTML(assistant)}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return { text: htmlLines.join("\n"), fallbackText: plainLines.join("\n"), parseMode: "HTML" };
}

type WatchStatsInput = {
  currentRoundMs?: number;
  sessionWorkMs?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
};

function formatWatchStatsPlain(stats: WatchStatsInput): string {
  const parts = [
    typeof stats.currentRoundMs === "number" ? `current run ${formatElapsedDuration(stats.currentRoundMs)}` : undefined,
    typeof stats.sessionWorkMs === "number" ? `total work ${formatDuration(stats.sessionWorkMs)}` : undefined,
    typeof stats.totalTokens === "number" ? formatCompactTokens(stats.totalTokens) : undefined,
    stats.estimatedCostUsd !== undefined ? formatUsd(stats.estimatedCostUsd) : undefined,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(" | ") : "no totals yet";
}

function getSnapshotCurrentRoundDurationMs(snapshot: ThreadStatusSnapshot): number | undefined {
  if (snapshot.lastTurnStatus === "completed" && typeof snapshot.lastTurnDurationMs === "number") {
    return Math.max(0, snapshot.lastTurnDurationMs);
  }

  if (snapshot.lastTurnCompletedAt && snapshot.lastTurnStartedAt) {
    return Math.max(0, snapshot.lastTurnCompletedAt.getTime() - snapshot.lastTurnStartedAt.getTime());
  }

  if (isActiveWatchStateValue(snapshot.state) && snapshot.lastTurnStartedAt) {
    return Math.max(0, Date.now() - snapshot.lastTurnStartedAt.getTime());
  }

  return undefined;
}

function getWatchCurrentRoundDurationMs(watch: WatchRecord): number | undefined {
  if (watch.lastTurnStatus === "completed" && typeof watch.lastTurnDurationMs === "number") {
    return Math.max(0, watch.lastTurnDurationMs);
  }

  const lastTurnStartedAt = watch.lastTurnStartedAt ? new Date(watch.lastTurnStartedAt) : undefined;
  const lastTurnCompletedAt = watch.lastTurnCompletedAt ? new Date(watch.lastTurnCompletedAt) : undefined;
  if (
    lastTurnStartedAt &&
    lastTurnCompletedAt &&
    !Number.isNaN(lastTurnStartedAt.getTime()) &&
    !Number.isNaN(lastTurnCompletedAt.getTime())
  ) {
    return Math.max(0, lastTurnCompletedAt.getTime() - lastTurnStartedAt.getTime());
  }

  if (
    lastTurnStartedAt &&
    !Number.isNaN(lastTurnStartedAt.getTime()) &&
    isActiveWatchStateValue(watch.lastState ?? "unknown")
  ) {
    return Math.max(0, Date.now() - lastTurnStartedAt.getTime());
  }

  return undefined;
}

function isActiveWatchStateValue(state: ThreadWatchState): boolean {
  return state === "running" || state === "observed_running" || state === "waiting_for_input";
}

function summarizeThreadUsage(workspace: string, threadId: string): WatchUsageAggregate | null {
  const workspaceSummary = summarizeWorkspaceUsage(workspace);
  if (!workspaceSummary) {
    return null;
  }

  const relatedThreads = workspaceSummary.threads.filter(
    (thread) => thread.threadId === threadId || thread.parentThreadId === threadId,
  );
  if (relatedThreads.length === 0) {
    return null;
  }

  return aggregateThreadUsage(relatedThreads);
}

function listUsageWorkspaceSummaries(config: TeleCodexConfig): WorkspaceUsageSummary[] {
  const workspaces = uniqueStrings(
    [...listWorkspaces(), ...config.allowedProjectRoots].filter((workspace) =>
      isWorkspaceAllowed(workspace, config.allowedProjectRoots),
    ),
  );

  return workspaces
    .map((workspace) => summarizeWorkspaceUsage(workspace))
    .filter((summary): summary is WorkspaceUsageSummary => Boolean(summary))
    .sort((left, right) => getWorkspaceShortName(left.workspace).localeCompare(getWorkspaceShortName(right.workspace)));
}

function resolveUsageWorkspace(argument: string, config: TeleCodexConfig): string | null {
  const query = normalizeUsageSearch(argument);
  if (!query) {
    return null;
  }

  const workspaces = uniqueStrings(
    [...listWorkspaces(), ...config.allowedProjectRoots].filter((workspace) =>
      isWorkspaceAllowed(workspace, config.allowedProjectRoots),
    ),
  );

  const exact = workspaces.find((workspace) => {
    const workspaceKey = normalizeUsageSearch(workspace);
    const shortNameKey = normalizeUsageSearch(getWorkspaceShortName(workspace));
    return workspaceKey === query || shortNameKey === query;
  });
  if (exact) {
    return exact;
  }

  return (
    workspaces.find((workspace) => {
      const workspaceKey = normalizeUsageSearch(workspace);
      const shortNameKey = normalizeUsageSearch(getWorkspaceShortName(workspace));
      return workspaceKey.includes(query) || shortNameKey.includes(query);
    }) ?? null
  );
}

function formatUsageWorkspaceLabel(summary: WorkspaceUsageSummary, _index: number): string {
  return `${getWorkspaceShortName(summary.workspace)} | ${formatUsd(summary.estimatedCostUsd)} | ${formatCompactTokens(summary.totals.totalTokens)}`;
}

function activeThreadIdForUsage(info: CodexSessionInfo, summary: WorkspaceUsageSummary): string | null {
  if (!info.threadId) {
    return null;
  }

  return sameWorkspacePath(info.workspace, summary.workspace) ? info.threadId : null;
}

function sameWorkspacePath(left: string, right: string): boolean {
  return workspaceCompareKey(left) === workspaceCompareKey(right);
}

function normalizeUsageSearch(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = workspaceCompareKey(value);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(value);
    }
  }
  return unique;
}

type WatchUsageAggregate = {
  totals: TokenTotals;
  estimatedActiveMs: number;
  estimatedCostUsd?: number;
  threadCount: number;
  subAgentCount: number;
  hasUnsupportedPricing: boolean;
};

function summarizeWatchedThreadUsage(transition: WatchTransition): WatchUsageAggregate | null {
  const workspace = transition.current.workspace || transition.watch.workspace;
  if (!workspace) {
    return null;
  }

  return summarizeThreadUsage(workspace, transition.watch.threadId);
}

function aggregateThreadUsage(threads: ThreadUsageSummary[]): WatchUsageAggregate {
  const totals = emptyTokenTotals();
  let estimatedActiveMs = 0;
  let estimatedCostUsd = 0;
  let hasPricedUsage = false;
  let hasUnsupportedPricing = false;
  let subAgentCount = 0;

  for (const thread of threads) {
    addTokenTotals(totals, thread.totals);
    estimatedActiveMs += thread.activity.estimatedActiveMs;
    if (thread.isSubAgent) {
      subAgentCount += 1;
    }

    if (typeof thread.estimatedCostUsd === "number") {
      estimatedCostUsd += thread.estimatedCostUsd;
      hasPricedUsage = true;
    } else if (thread.model) {
      hasUnsupportedPricing = true;
    }
  }

  return {
    totals,
    estimatedActiveMs,
    estimatedCostUsd: hasPricedUsage ? estimatedCostUsd : undefined,
    threadCount: threads.length,
    subAgentCount,
    hasUnsupportedPricing,
  };
}

function emptyTokenTotals(): TokenTotals {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function addTokenTotals(target: TokenTotals, source: TokenTotals): void {
  target.totalTokens += source.totalTokens;
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
}

function formatWatchPickerLabel(snapshot: ThreadStatusSnapshot): string {
  const title = trimLine(snapshot.title || "(untitled)", 24);
  const updated = snapshot.lastUpdatedAt ? formatRelativeTime(snapshot.lastUpdatedAt) : "unknown";
  const usage = summarizeThreadUsage(snapshot.workspace, snapshot.threadId);
  const currentRoundMs = getSnapshotCurrentRoundDurationMs(snapshot);
  const round = currentRoundMs !== undefined ? formatElapsedDuration(currentRoundMs) : "unknown";
  const work = usage ? formatDuration(usage.estimatedActiveMs) : "no usage";
  return `${formatWatchState(snapshot.state)} | ${title} | current run ${round} | total work ${work} | ${updated}`;
}

function formatWatchRecordLabel(watch: WatchRecord): string {
  const title = trimLine(watch.title || "(untitled)", 24);
  const updated = watch.lastUpdatedAt ? formatRelativeTime(new Date(watch.lastUpdatedAt)) : "unknown";
  return `${formatWatchState(watch.lastState ?? "unknown")} | ${title} | ${updated}`;
}

function formatWatchState(state: ThreadWatchState): string {
  switch (state) {
    case "observed_running":
      return "running";
    case "waiting_for_input":
      return "waiting";
    case "not_found":
      return "not found";
    default:
      return state;
  }
}

function formatLaunchProfileLabelForTelegram(profile: CodexLaunchProfile, isCurrent = false): string {
  const prefix = profile.unsafe ? "⚠️" : "🛡️";
  const selected = isCurrent ? " ✓" : "";
  return `${prefix} ${profile.label} · ${formatLaunchProfileBehaviorForTelegram(profile)}${selected}`;
}

function formatLaunchProfileBehaviorForTelegram(
  profile: Pick<CodexLaunchProfile, "sandboxMode" | "approvalPolicy">,
): string {
  return `${formatSandboxModeForTelegram(profile.sandboxMode)} / ${formatApprovalPolicyForTelegram(profile.approvalPolicy)}`;
}

function formatLaunchBehaviorTextForTelegram(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }

  const [sandboxMode, approvalPolicy] = value.split("/").map((part) => part.trim());
  if (sandboxMode && approvalPolicy) {
    return `${formatSandboxModeForTelegram(sandboxMode)} / ${formatApprovalPolicyForTelegram(approvalPolicy)}`;
  }

  return value
    .replaceAll("danger-full-access", "full filesystem access")
    .replaceAll("workspace-write", "workspace write")
    .replaceAll("read-only", "read only");
}

function formatSandboxModeForTelegram(mode: CodexSandboxMode | string): string {
  switch (mode) {
    case "danger-full-access":
      return "full filesystem access";
    case "workspace-write":
      return "workspace write";
    case "read-only":
      return "read only";
    default:
      return mode;
  }
}

function formatApprovalPolicyForTelegram(policy: CodexApprovalPolicy | string): string {
  switch (policy) {
    case "never":
      return "no prompts";
    case "on-request":
      return "ask when needed";
    case "on-failure":
      return "ask after failure";
    default:
      return policy;
  }
}

function renderSessionInfoPlain(info: CodexSessionInfo): string {
  return [
    `State: ${info.threadId ? "active" : "not started"}`,
    `Launch profile: ${info.launchProfileLabel} (${formatLaunchBehaviorTextForTelegram(info.launchProfileBehavior)})${info.unsafeLaunch ? " [full access]" : ""}`,
    info.nextLaunchProfileId
      ? `Next launch profile: ${info.nextLaunchProfileLabel} (${formatLaunchBehaviorTextForTelegram(info.nextLaunchProfileBehavior)})${info.nextUnsafeLaunch ? " [full access]" : ""}`
      : undefined,
    info.model ? `Model: ${info.model}` : undefined,
    info.reasoningEffort ? `Reasoning effort: ${info.reasoningEffort}` : undefined,
    info.sessionTokens ? formatSessionTokensPlain(info.sessionTokens) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderSessionInfoHTML(info: CodexSessionInfo): string {
  return [
    `<b>State:</b> <code>${escapeHTML(info.threadId ? "active" : "not started")}</code>`,
    `<b>Launch profile:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`,
    `<b>Access:</b> <code>${escapeHTML(formatLaunchBehaviorTextForTelegram(info.launchProfileBehavior))}</code>${info.unsafeLaunch ? " ⚠️" : ""}`,
    info.nextLaunchProfileId
      ? `<b>Next launch profile:</b> <code>${escapeHTML(info.nextLaunchProfileLabel ?? "")}</code> <i>(${escapeHTML(formatLaunchBehaviorTextForTelegram(info.nextLaunchProfileBehavior))})</i>${info.nextUnsafeLaunch ? " ⚠️" : ""}`
      : undefined,
    info.model ? `<b>Model:</b> <code>${escapeHTML(info.model)}</code>` : undefined,
    info.reasoningEffort ? `<b>Reasoning effort:</b> <code>${escapeHTML(info.reasoningEffort)}</code>` : undefined,
    info.sessionTokens ? `<b>Session tokens:</b> <code>${escapeHTML(formatSessionTokensValue(info.sessionTokens))}</code>` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderStatusSnapshot(
  snapshot: CodexSessionStatusSnapshot,
  options: { includeAssistantOutput?: boolean; includeErrorDetails?: boolean } = {},
): RenderedText {
  const stateLabel = formatRuntimeState(snapshot.state);
  const pendingQuestions = snapshot.pendingUserInput?.questions ?? [];
  const isWaitingWithoutCapturedQuestion =
    snapshot.state === "waiting_for_input" && pendingQuestions.length === 0;

  const plainLines = [
    "Codex status:",
    `State: ${stateLabel}`,
    snapshot.appServerThreadStatus ? `Bridge: ${snapshot.appServerThreadStatus}` : undefined,
    snapshot.lastTurnStatus
      ? `Last turn: ${snapshot.lastTurnStatus}`
      : undefined,
    snapshot.lastUpdatedAt ? `Last updated: ${formatStatusDate(snapshot.lastUpdatedAt)}` : undefined,
    snapshot.lastTurnError
      ? `Error: ${options.includeErrorDetails ? snapshot.lastTurnError : "details hidden by configuration"}`
      : undefined,
    snapshot.readWarning ? "Some status details are unavailable." : undefined,
  ].filter((line): line is string => Boolean(line));

  const htmlLines = [
    "<b>Codex status:</b>",
    `<b>State:</b> <code>${escapeHTML(stateLabel)}</code>`,
    snapshot.appServerThreadStatus
      ? `<b>Bridge:</b> <code>${escapeHTML(snapshot.appServerThreadStatus)}</code>`
      : undefined,
    snapshot.lastTurnStatus
      ? `<b>Last turn:</b> <code>${escapeHTML(snapshot.lastTurnStatus)}</code>`
      : undefined,
    snapshot.lastUpdatedAt
      ? `<b>Last updated:</b> <code>${escapeHTML(formatStatusDate(snapshot.lastUpdatedAt))}</code>`
      : undefined,
    snapshot.lastTurnError && options.includeErrorDetails
      ? `<b>Error:</b> ${escapeHTML(snapshot.lastTurnError)}`
      : undefined,
    snapshot.lastTurnError && !options.includeErrorDetails
      ? "<b>Error:</b> <code>details hidden by configuration</code>"
      : undefined,
    snapshot.readWarning ? "Some status details are unavailable." : undefined,
  ].filter((line): line is string => Boolean(line));

  if (pendingQuestions.length > 0) {
    plainLines.push(
      "",
      "Pending question:",
      ...pendingQuestions.map((question, index) => `${index + 1}. ${question.header}: ${question.question}`),
      "",
      "Reply with the answer, or use /answer <answer>.",
    );
    htmlLines.push(
      "",
      "<b>Pending question:</b>",
      ...pendingQuestions.map(
        (question, index) =>
          `${index + 1}. <b>${escapeHTML(question.header)}:</b> ${escapeHTML(question.question)}`,
      ),
      "",
      "Reply with the answer, or use <code>/answer &lt;answer&gt;</code>.",
    );
  } else if (isWaitingWithoutCapturedQuestion) {
    const warning =
      "Waiting for user input, but this bridge did not receive the live question handle. Answer in the app that asked it, or start the turn through Telegram next time.";
    plainLines.push("", warning);
    htmlLines.push("", `<i>${escapeHTML(warning)}</i>`);
  }

  if (options.includeAssistantOutput && snapshot.latestAssistantMessage) {
    const latest = truncateStatusText(snapshot.latestAssistantMessage, 1400);
    plainLines.push("", "Latest assistant output:", latest);
    htmlLines.push("", "<b>Latest assistant output:</b>", `<pre>${escapeHTML(latest)}</pre>`);
  } else if (!options.includeAssistantOutput && snapshot.latestAssistantMessage) {
    plainLines.push("", "Latest assistant output is hidden by configuration.");
    htmlLines.push("", "<i>Latest assistant output is hidden by configuration.</i>");
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

function renderUsageSummary(
  summary: WorkspaceUsageSummary,
  activeThreadId: string | null,
  _authMethod: "api-key" | "cli" | "none",
): RenderedText {
  const activeThread = activeThreadId
    ? summary.threads.find((thread) => thread.threadId === activeThreadId) ?? null
    : null;
  const threadBreakdown = `${summary.threadCount} total (${summary.mainThreadCount} direct, ${summary.subAgentThreadCount} related)`;
  const plainLines = ["Usage:"];
  const htmlLines = ["<b>Usage:</b>"];

  const totalPlainLines = [
    "",
    "Total:",
    `Threads: ${threadBreakdown}`,
    summary.summarizedThreadCount === summary.threadCount
      ? undefined
      : `Counted: ${summary.summarizedThreadCount}/${summary.threadCount}`,
    `Work time: ${formatDuration(summary.activity.estimatedActiveMs)}`,
    `Direct time: ${formatDuration(summary.activity.mainThreadActiveMs)}`,
    ...(summary.activity.subAgentActiveMs > 0
      ? [`Related time: ${formatDuration(summary.activity.subAgentActiveMs)}`]
      : []),
    `Tokens: ${formatTotalsPlain(summary.totals)}`,
    `Cost: ${formatUsd(summary.estimatedCostUsd)}`,
  ].filter((line): line is string => Boolean(line));
  const totalHtmlLines = [
    "",
    "<b>Total:</b>",
    `<b>Threads:</b> <code>${escapeHTML(threadBreakdown)}</code>`,
    summary.summarizedThreadCount === summary.threadCount
      ? undefined
      : `<b>Counted:</b> <code>${escapeHTML(`${summary.summarizedThreadCount}/${summary.threadCount}`)}</code>`,
    `<b>Work time:</b> <code>${escapeHTML(formatDuration(summary.activity.estimatedActiveMs))}</code>`,
    `<b>Direct time:</b> <code>${escapeHTML(formatDuration(summary.activity.mainThreadActiveMs))}</code>`,
    ...(summary.activity.subAgentActiveMs > 0
      ? [`<b>Related time:</b> <code>${escapeHTML(formatDuration(summary.activity.subAgentActiveMs))}</code>`]
      : []),
    `<b>Tokens:</b> <code>${escapeHTML(formatTotalsPlain(summary.totals))}</code>`,
    `<b>Cost:</b> <code>${escapeHTML(formatUsd(summary.estimatedCostUsd))}</code>`,
  ].filter((line): line is string => Boolean(line));
  plainLines.push(...totalPlainLines);
  htmlLines.push(...totalHtmlLines);

  if (activeThread) {
    plainLines.push(
      "",
      "Current chat:",
      `Model: ${activeThread.model ?? "(unknown)"}`,
      `Work time: ${formatDuration(activeThread.activity.estimatedActiveMs)}`,
      `Tokens: ${formatTotalsPlain(activeThread.totals)}`,
      `Cost: ${formatUsd(activeThread.estimatedCostUsd)}`,
    );
    htmlLines.push(
      "",
      "<b>Current chat:</b>",
      `<b>Model:</b> <code>${escapeHTML(activeThread.model ?? "(unknown)")}</code>`,
      `<b>Work time:</b> <code>${escapeHTML(formatDuration(activeThread.activity.estimatedActiveMs))}</code>`,
      `<b>Tokens:</b> <code>${escapeHTML(formatTotalsPlain(activeThread.totals))}</code>`,
      `<b>Cost:</b> <code>${escapeHTML(formatUsd(activeThread.estimatedCostUsd))}</code>`,
    );
  } else if (activeThreadId) {
    plainLines.push("", "Current chat: no saved usage yet.");
    htmlLines.push("", "<b>Current chat:</b> no saved usage yet.");
  }

  const pricedModels = summary.byModel.slice(0, 5);
  if (pricedModels.length > 0) {
    plainLines.push("", "By model:");
    htmlLines.push("", "<b>By model:</b>");
    for (const model of pricedModels) {
      const line = `${model.model}: ${model.threadCount} session${model.threadCount === 1 ? "" : "s"} | ${formatUsd(model.estimatedCostUsd)} | ${formatCompactTokens(model.totals.totalTokens)}`;
      plainLines.push(`- ${line}`);
      htmlLines.push(`- <code>${escapeHTML(line)}</code>`);
    }
  }

  if (summary.unsupportedModels.length > 0) {
    const line = `Missing cost for: ${summary.unsupportedModels.join(", ")}`;
    plainLines.push("", line);
    htmlLines.push("", escapeHTML(line));
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

function renderRateLimitSummary(summary: RateLimitSummary): RenderedText {
  const observed = formatRelativeTime(summary.observedAt);
  const plainLines = [
    "Rate limits:",
    summary.planType ? `Plan: ${summary.planType}` : undefined,
    summary.limitId ? `Limit: ${summary.limitId}` : undefined,
    `Observed: ${observed}`,
    summary.primary ? formatRateLimitWindowPlain("5h", summary.primary) : undefined,
    summary.secondary ? formatRateLimitWindowPlain("weekly", summary.secondary) : undefined,
    summary.rateLimitReachedType ? `Reached: ${summary.rateLimitReachedType}` : undefined,
  ].filter((line): line is string => Boolean(line));

  const htmlLines = [
    "<b>Rate limits:</b>",
    summary.planType ? `<b>Plan:</b> <code>${escapeHTML(summary.planType)}</code>` : undefined,
    summary.limitId ? `<b>Limit:</b> <code>${escapeHTML(summary.limitId)}</code>` : undefined,
    `<b>Observed:</b> <code>${escapeHTML(observed)}</code>`,
    summary.primary ? formatRateLimitWindowHTML("5h", summary.primary) : undefined,
    summary.secondary ? formatRateLimitWindowHTML("weekly", summary.secondary) : undefined,
    summary.rateLimitReachedType
      ? `<b>Reached:</b> <code>${escapeHTML(summary.rateLimitReachedType)}</code>`
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

function formatRateLimitWindowPlain(label: string, window: RateLimitWindowSummary): string {
  return `${label}: ${formatPercent(window.usedPercent)} used | ${formatPercent(window.remainingPercent)} left${formatResetSuffix(window)}`;
}

function formatRateLimitWindowHTML(label: string, window: RateLimitWindowSummary): string {
  return `<b>${escapeHTML(label)}:</b> <code>${escapeHTML(`${formatPercent(window.usedPercent)} used | ${formatPercent(window.remainingPercent)} left${formatResetSuffix(window)}`)}</code>`;
}

function formatResetSuffix(window: RateLimitWindowSummary): string {
  if (!window.resetsAt) {
    return "";
  }

  const remainingMs = window.resetsAt.getTime() - Date.now();
  return remainingMs > 0 ? ` | resets in ${formatLimitDuration(remainingMs)}` : " | reset due";
}

function formatRuntimeState(state: CodexSessionStatusSnapshot["state"]): string {
  switch (state) {
    case "not_started":
      return "not started";
    case "waiting_for_input":
      return "waiting for input";
    case "running":
      return "running";
    case "idle":
      return "idle";
    case "unknown":
      return "unknown";
  }
}

function formatStatusDate(date: Date): string {
  return `${formatRelativeTime(date)} / ${date.toISOString()}`;
}

function truncateStatusText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1)}...`;
}

function renderLaunchSummaryPlain(info: CodexSessionInfo): string {
  return `Launch: ${info.launchProfileLabel} (${info.launchProfileBehavior})${info.unsafeLaunch ? " [unsafe]" : ""}`;
}

function renderLaunchSummaryHTML(info: CodexSessionInfo): string {
  const suffix = info.unsafeLaunch ? " ⚠️" : "";
  return `<b>Launch:</b> <code>${escapeHTML(info.launchProfileLabel)}</code> <i>(${escapeHTML(info.launchProfileBehavior)})</i>${suffix}`;
}

function renderToolStartMessage(toolName: string): RenderedText {
  return {
    text: `<b>🔧 Running:</b> <code>${escapeHTML(toolName)}</code>`,
    fallbackText: `🔧 Running: ${toolName}`,
    parseMode: "HTML",
  };
}

function renderToolEndMessage(toolName: string, partialResult: string, isError: boolean): RenderedText {
  const preview = summarizeToolOutput(partialResult);
  const icon = isError ? "❌" : "✅";
  const htmlLines = [`<b>${icon}</b> <code>${escapeHTML(toolName)}</code>`];
  const plainLines = [`${icon} ${toolName}`];

  if (preview) {
    htmlLines.push(`<pre>${escapeHTML(preview)}</pre>`);
    plainLines.push(preview);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

export function formatToolSummaryLine(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) {
    return "";
  }

  const summarizedCounts = new Map<string, number>();
  for (const [toolName, count] of toolCounts.entries()) {
    const summaryName = summarizeToolName(toolName);
    summarizedCounts.set(summaryName, (summarizedCounts.get(summaryName) ?? 0) + count);
  }

  const entries = [...summarizedCounts.entries()].sort((left, right) => {
    const countDelta = right[1] - left[1];
    return countDelta !== 0 ? countDelta : left[0].localeCompare(right[0]);
  });
  const tools = entries
    .map(([name, count]) => formatSummaryEntry(name, count))
    .join(", ");
  return `Tools used: ${tools}`;
}

function renderTodoList(items: Array<{ text: string; completed: boolean }>): string {
  const lines = items.map((item) => {
    const icon = item.completed ? "✅" : "⬜";
    return `${icon} ${escapeHTML(item.text)}`;
  });
  return `📋 <b>Plan</b>\n${lines.join("\n")}`;
}

export function formatTurnUsageLine(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): string {
  return `🪙 input: ${usage.inputTokens} · cached input: ${usage.cachedInputTokens} · output: ${usage.outputTokens}`;
}

export function summarizeToolName(toolName: string): string {
  if (toolName.startsWith("🔍 ")) {
    return "web_fetch";
  }

  if (toolName === "file_change") {
    return "file_change";
  }

  if (toolName === "⚠️ error") {
    return "error";
  }

  if (toolName.startsWith("mcp:")) {
    const tool = toolName.split("/").at(-1) ?? toolName;
    if (SUBAGENT_TOOL_NAMES.has(tool)) {
      return "related session";
    }
    return tool;
  }

  return "bash";
}

function formatSummaryEntry(name: string, count: number): string {
  if (count <= 1) {
    return name;
  }

  const label = name === "related session" ? "related sessions" : name;
  return `${count}x ${label}`;
}

const SUBAGENT_TOOL_NAMES = new Set(["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"]);

function formatSessionTokensValue(tokens: { input: number; cached: number; output: number }): string {
  return `input: ${tokens.input} · cached input: ${tokens.cached} · output: ${tokens.output}`;
}

function formatSessionTokensPlain(tokens: { input: number; cached: number; output: number }): string {
  return `Session tokens: ${formatSessionTokensValue(tokens)}`;
}

function formatTotalsPlain(totals: TokenTotals): string {
  return `total: ${formatInteger(totals.totalTokens)} | input: ${formatInteger(totals.inputTokens)} | cached input: ${formatInteger(totals.cachedInputTokens)} | output: ${formatInteger(totals.outputTokens)}`;
}

function formatCompactTokens(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B tok`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M tok`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K tok`;
  }
  return `${value} tok`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatUsd(value: number | undefined): string {
  if (value === undefined) {
    return "(unavailable)";
  }

  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(3)}`;
  }
  return `$${value.toFixed(4)}`;
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;
}

function formatDuration(valueMs: number): string {
  const totalMinutes = Math.round(valueMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${minutes}m`;
}

function formatLimitDuration(valueMs: number): string {
  const totalMinutes = Math.max(0, Math.round(valueMs / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function formatElapsedDuration(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.round(valueMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

async function safeReply(ctx: Context, text: string, options: TextOptions = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  const parseMode = options.parseMode !== undefined ? options.parseMode : ("HTML" as TelegramParseMode);
  const messageThreadId =
    options.messageThreadId ?? ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;

  const chunks = splitTelegramText(text);
  const fallbackChunks = options.fallbackText ? splitTelegramText(options.fallbackText) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, chatId, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
      messageThreadId,
    });
  }
}

async function sendTextMessage(
  api: Context["api"],
  chatId: TelegramChatId,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    return await api.sendMessage(chatId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      return await api.sendMessage(chatId, options.fallbackText, {
        ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
        reply_markup: options.replyMarkup,
      });
    }
    throw error;
  }
}

async function safeEditMessage(
  bot: Bot<Context>,
  chatId: TelegramChatId,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";

  try {
    await bot.api.editMessageText(chatId, messageId, text, {
      ...(parseMode ? { parse_mode: parseMode } : {}),
      reply_markup: options.replyMarkup,
    });
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    if (parseMode && options.fallbackText !== undefined && isTelegramParseError(error)) {
      await bot.api.editMessageText(chatId, messageId, options.fallbackText, {
        reply_markup: options.replyMarkup,
      });
      return;
    }

    throw error;
  }
}

async function downloadTelegramFile(
  api: Context["api"],
  token: string,
  fileId: string,
  maxBytes = MAX_AUDIO_FILE_SIZE,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  if (file.file_size && file.file_size > maxBytes) {
    throw new Error(
      `Telegram file too large (${Math.round(file.file_size / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB)`,
    );
  }

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(file.file_path) || ".bin";
  const tempPath = path.join(tmpdir(), `telecodex-file-${randomUUID()}${extension}`);
  await writeFile(tempPath, buffer);
  return tempPath;
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

function splitMarkdownForTelegram(markdown: string): RenderedChunk[] {
  if (!markdown) {
    return [];
  }

  const chunks: RenderedChunk[] = [];
  let remaining = markdown;

  while (remaining) {
    const maxLength = Math.min(remaining.length, FORMATTED_CHUNK_TARGET);
    const initialCut = findPreferredSplitIndex(remaining, maxLength);
    const candidate = remaining.slice(0, initialCut) || remaining.slice(0, 1);
    const rendered = renderMarkdownChunkWithinLimit(candidate);

    chunks.push(rendered);
    remaining = remaining.slice(rendered.sourceText.length).trimStart();
  }

  return chunks;
}

function renderMarkdownChunkWithinLimit(markdown: string): RenderedChunk {
  if (!markdown) {
    return {
      text: "",
      fallbackText: "",
      parseMode: "HTML",
      sourceText: "",
    };
  }

  let sourceText = markdown;
  let rendered = formatMarkdownMessage(sourceText);

  while (rendered.text.length > TELEGRAM_MESSAGE_LIMIT && sourceText.length > 1) {
    const nextLength = Math.max(1, sourceText.length - Math.max(100, Math.ceil(sourceText.length * 0.1)));
    sourceText = sourceText.slice(0, nextLength).trimEnd() || sourceText.slice(0, nextLength);
    rendered = formatMarkdownMessage(sourceText);
  }

  return {
    ...rendered,
    sourceText,
  };
}

function formatMarkdownMessage(markdown: string): RenderedText {
  try {
    return {
      text: formatTelegramHTML(markdown),
      fallbackText: markdown,
      parseMode: "HTML",
    };
  } catch (error) {
    console.error("Failed to format Telegram HTML, falling back to plain text", error);
    return {
      text: markdown,
      fallbackText: markdown,
      parseMode: undefined,
    };
  }
}

function findPreferredSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return Math.max(1, text.length);
  }

  const newlineIndex = text.lastIndexOf("\n", maxLength);
  if (newlineIndex >= maxLength * 0.5) {
    return Math.max(1, newlineIndex);
  }

  const spaceIndex = text.lastIndexOf(" ", maxLength);
  if (spaceIndex >= maxLength * 0.5) {
    return Math.max(1, spaceIndex);
  }

  return Math.max(1, maxLength);
}

function buildStreamingPreview(text: string): string {
  if (text.length <= STREAMING_PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, STREAMING_PREVIEW_LIMIT)}\n\n… streaming (preview truncated)`;
}

function appendWithCap(base: string, addition: string, cap: number): string {
  const combined = `${base}${addition}`;
  return combined.length <= cap ? combined : combined.slice(-cap);
}

function summarizeToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= TOOL_OUTPUT_PREVIEW_LIMIT ? trimmed : `${trimmed.slice(-TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`;
}

function trimLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  const normalized = normalizeWorkspacePath(workspace);
  const baseName = path.basename(normalized);
  if (baseName) {
    return baseName;
  }

  const root = path.parse(normalized).root.replace(/[\\/]+$/g, "");
  return root || "Workspace";
}

function formatWorkspacePickerName(workspace: string, index: number, allWorkspaces: string[]): string {
  const shortName = getWorkspaceShortName(workspace);
  const duplicates = allWorkspaces.filter((candidate) => getWorkspaceShortName(candidate) === shortName);
  return duplicates.length > 1 ? `${shortName} (${index + 1})` : shortName;
}

function normalizeWorkspacePath(workspace: string): string {
  const withoutExtendedPrefix = workspace.startsWith("\\\\?\\UNC\\")
    ? `\\\\${workspace.slice("\\\\?\\UNC\\".length)}`
    : workspace.startsWith("\\\\?\\")
      ? workspace.slice("\\\\?\\".length)
      : workspace;

  const normalized = path.normalize(withoutExtendedPrefix);
  const parsed = path.parse(normalized);
  if (normalized.length <= parsed.root.length) {
    return normalized;
  }

  return normalized.replace(/[\\/]+$/g, "");
}

function workspaceCompareKey(workspace: string): string {
  const normalized = normalizeWorkspacePath(workspace);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function formatRelativeTime(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1000));

  if (deltaSeconds < 60) {
    return "just now";
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 14) {
    return `${deltaDays}d ago`;
  }

  const deltaWeeks = Math.floor(deltaDays / 7);
  return `${deltaWeeks}w ago`;
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
}

function isTelegramParseError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes("unsupported start tag") ||
    message.includes("unexpected end tag") ||
    message.includes("entity name") ||
    message.includes("parse entities")
  );
}

function renderPromptFailure(accumulatedText: string, error: unknown): string {
  const message = friendlyErrorText(error);
  return accumulatedText.trim() ? `${accumulatedText.trim()}\n\n⚠️ ${message}` : `⚠️ ${message}`;
}

function shouldRetryWithFallbackModel(
  error: unknown,
  currentModel: string | undefined,
  fallbackModel: string,
  hasVisibleOutput: boolean,
): boolean {
  if (hasVisibleOutput || !currentModel) {
    return false;
  }

  if (currentModel === fallbackModel) {
    return false;
  }

  return /requires a newer version of codex/i.test(formatError(error));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
