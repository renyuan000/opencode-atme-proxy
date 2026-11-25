import type { AppConfig } from "./config.js";
import type { ChatContextStore } from "./chat-context.js";
import type { ConcurrentDispatcher } from "./dispatcher.js";
import type { IntentService } from "./intent-service.js";
import type { Logger } from "./logger.js";
import type { PlatformAdapter } from "./ports.js";
import { extractDocumentText } from "./document.js";
import { ocrImage } from "./ocr.js";
import type { RelevanceService } from "./relevance.js";
import type { TaskService } from "./task-service.js";
import type { Classification, IncomingMessage, NotificationView } from "./types.js";
import { formatLocalTime, toErrorMessage, truncate } from "./util.js";

export interface ScanServiceOptions {
  config: AppConfig;
  logger: Logger;
  relevance(): RelevanceService;
  platform: PlatformAdapter;
  dispatcher: ConcurrentDispatcher;
  chatContext: ChatContextStore;
  intentService: IntentService;
  taskService: TaskService;
  filterEnabled: boolean;
  groupIds: Set<string>;
  dedup: { has(key: string, chatId?: string): boolean };
  activeMessageIds: Set<string>;
  ownerOpenId(): string | undefined;
  conversationIdFor?(message: IncomingMessage): string;
  isMention(message: IncomingMessage): boolean;
  isFileRelevant?(message: IncomingMessage, fileName: string, content?: string): boolean | undefined;
  onMessage(message: IncomingMessage, wait: boolean): Promise<void>;
  markProcessed(message: IncomingMessage): Promise<void>;
  sendToApprover(text: string): Promise<boolean>;
  sendToOwner(text: string): Promise<boolean>;
  sendOwnerNotification?(view: NotificationView): Promise<boolean>;
}

export class ScanService {
  constructor(private readonly options: ScanServiceOptions) {}

  async handlePolledBatch(messages: IncomingMessage[]): Promise<void> {
    let failed = false;
    const candidates = messages.filter((message) => {
      if (message.senderType !== "user") return false;
      if (message.chat.kind !== "group") return false;
      if (this.options.config.policy.defaultDenyGroups) {
        if (!this.options.groupIds.has(message.chat.id)) return false;
      }
      return true;
    });
    if (candidates.length === 0) return;

    for (const message of candidates) {
      if (!this.options.isMention(message)) continue;
      try {
        await this.options.onMessage(message, true);
      } catch (error) {
        failed = true;
        this.options.logger.error("polled mention handling failed", {
          messageId: message.messageId,
          error: toErrorMessage(error),
        });
      }
    }
    const ownerId = this.options.ownerOpenId();
    const plain = candidates.filter(
      (message) => !this.options.isMention(message) && message.sender.id !== ownerId,
    );
    if (plain.length === 0) return;

    const fresh = plain.filter((message) => {
      const key = `${message.platform}:${message.messageId}`;
      return !this.options.dedup.has(key, message.chat.id) && !this.options.activeMessageIds.has(key);
    });
    if (fresh.length === 0) return;
    const perSender = new Map<string, number>();
    const capped = fresh.filter((message) => {
      const count = (perSender.get(message.sender.id) ?? 0) + 1;
      if (count > this.options.config.botReply.maxMessagesPerSenderPerRun) return false;
      perSender.set(message.sender.id, count);
      return true;
    });
    if (capped.length < fresh.length) {
      this.options.logger.warn("per-sender message cap applied", {
        dropped: fresh.length - capped.length,
      });
    }
    for (const message of capped) {
      this.options.activeMessageIds.add(`${message.platform}:${message.messageId}`);
    }

    const chatId = capped[0]?.chat.id ?? "unknown";
    const budget = this.options.config.budget.maxMessagesPerRun;
    const limitedMessages = capped.slice(0, budget);
    if (limitedMessages.length < capped.length) {
      await this.options.sendToApprover(
        `本轮消息超过预算，仅处理 ${limitedMessages.length}/${capped.length} 条；剩余留待下一轮。`,
      );
      failed = true;
    }
    try {
      await this.options.dispatcher.enqueue({
        id: `scan:${chatId}:${limitedMessages[0]?.messageId ?? Date.now()}`,
        key: `${chatId}:scan`,
        keyConcurrency: this.options.config.concurrency.scanConcurrency,
        priority: 5,
        timeoutMs: this.options.config.concurrency.scanTimeoutMs,
        run: async (signal) => {
          try {
            await this.handlePolledBatchJob(limitedMessages, signal);
          } finally {
            for (const message of capped) {
              this.options.activeMessageIds.delete(`${message.platform}:${message.messageId}`);
            }
          }
        },
      });
    } catch (error) {
      for (const message of capped) {
        this.options.activeMessageIds.delete(`${message.platform}:${message.messageId}`);
      }
      this.options.logger.error("polled batch failed", {
        chatId,
        count: capped.length,
        error: toErrorMessage(error),
      });
      throw error;
    }
    if (failed) {
      throw new Error("polled batch had failed messages; cursor not advanced");
    }
  }

  private async skipIrrelevantFile(message: IncomingMessage, content?: string): Promise<boolean> {
    const files = (message.attachments ?? []).filter((item) => item.kind === "file");
    if (files.length === 0 || !this.options.isFileRelevant) return false;
    for (const file of files) {
      const relevant = this.options.isFileRelevant(message, file.name ?? "", content);
      if (relevant === false) {
        await this.options.markProcessed(message);
        this.options.logger.info("irrelevant file skipped", {
          messageId: message.messageId,
          fileName: file.name,
          chatId: message.chat.id,
        });
        return true;
      }
    }
    return false;
  }

  private async enrichFile(
    message: IncomingMessage,
    allowNearDuplicate = false,
  ): Promise<IncomingMessage> {
    const files = (message.attachments ?? []).filter(
      (item) => item.kind === "file" && item.key,
    );
    const images = (message.attachments ?? []).filter(
      (item) => item.kind === "image" && item.key,
    );
    if ((files.length === 0 && images.length === 0) || !this.options.platform.fetchResource) {
      return message;
    }
    const parts: string[] = [];
    for (const file of files.slice(0, 2)) {
      try {
        const resource = await this.options.platform.fetchResource(
          message.messageId,
          file.key!,
          "file",
        );
        if (resource.data.length > 8 * 1024 * 1024) continue;
        const text = await extractDocumentText(resource.data, resource.mime, file.name);
        if (text) parts.push(`[文件 ${file.name ?? ""}]\n${clip(text, 8000, file.name ?? "文件")}`);
      } catch (error) {
        this.options.logger.warn("failed to analyze scanned file", {
          messageId: message.messageId,
          error: toErrorMessage(error),
        });
      }
    }
    for (const image of images.slice(0, 2)) {
      try {
        const resource = await this.options.platform.fetchResource(
          message.messageId,
          image.key!,
          "image",
        );
        if (resource.data.length > 8 * 1024 * 1024) continue;
        const text = await ocrImage(resource.data, resource.mime, {
          ...this.options.config.ocr,
          allowNearDuplicate,
          scope: message.chat.id,
        });
        if (text) {
          parts.push(`[图片 OCR，仅作文字参考]\n${clip(text, 8000, "图片 OCR")}`);
        }
      } catch (error) {
        this.options.logger.warn("failed to OCR scanned image", {
          messageId: message.messageId,
          error: toErrorMessage(error),
        });
      }
    }
    return parts.length > 0 ? { ...message, text: `${message.text}\n\n${parts.join("\n\n")}` } : message;
  }

  private async enrichFiles(
    messages: IncomingMessage[],
    allowNearDuplicate = false,
  ): Promise<IncomingMessage[]> {
    return Promise.all(messages.map((message) => this.enrichFile(message, allowNearDuplicate)));
  }

  async handleGroupScan(message: IncomingMessage, signal: AbortSignal): Promise<void> {
    if (message.sender.id === this.options.ownerOpenId()) return;
    const enriched = await this.enrichFile(message, true);
    if (await this.skipIrrelevantFile(message, enriched.text)) return;
    const classification = await this.options.intentService.classifyOne(enriched, signal);
    if (!classification?.relevant) return;
    if (
      classification.ownership === "external" &&
      (classification.ownershipConfidence ?? 0) >= 0.6
    ) {
      this.options.logger.info("ignored external ownership", {
        messageId: message.messageId,
        chatId: message.chat.id,
        reason: classification.ownershipReason ?? classification.reason,
      });
      await this.options.markProcessed(message);
      return;
    }
    if (this.hasMedia(message)) {
      await this.queueMediaApproval(enriched, classification);
      await this.options.markProcessed(message);
      return;
    }
    let handled = false;
    if (
      classification.actionability === "task" &&
      classification.confidence >= this.options.config.filter.minTaskConfidence
    ) {
      const task = await this.options.taskService.ensureTask(
        enriched,
        classification,
        "group_scan",
      );
      if (task) handled = true;
    } else if (classification.ownerAttention) {
      handled = await this.options.sendToApprover(
        [
          "群消息需要你关注",
          `群：${enriched.chat.name ?? enriched.chat.id}`,
          `发送人：${enriched.sender.displayName ?? enriched.sender.id}`,
          `内容：${truncate(enriched.text, 200)}`,
          `判断：${classification.reason}`,
          `建议：${suggestedActionLabel(classification.actionability)}`,
        ].join("\n"),
      );
    } else {
      handled = true;
    }
    if (handled) await this.options.markProcessed(message);
  }

  private async handlePolledBatchJob(
    messages: IncomingMessage[],
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.options.filterEnabled) {
      await this.digestWithoutFilter(messages);
      return;
    }
    const enrichedAll = await this.enrichFiles(messages, true);
    const accepted: IncomingMessage[] = [];
    for (const message of enrichedAll) {
      if (await this.skipIrrelevantFile(message, message.text)) continue;
      accepted.push(message);
    }
    if (accepted.length === 0) return;
    const enriched = accepted;
    const first = enriched[0];
    const history = first
      ? this.options.chatContext
          .recent(`${first.platform}:${first.chat.id}`, 12)
          .map((item) => ({
            sender: item.senderName ?? item.senderId,
            text: item.text,
            time: item.at,
          }))
      : [];
    const { items, stats } = await this.options.relevance().classify(enriched, signal, history);
    if (stats.totalTokens > this.options.config.budget.maxTokensPerRun) {
      await this.options.sendToApprover(
        `本轮筛选 token 超预算：${stats.totalTokens}/${this.options.config.budget.maxTokensPerRun}，已停止后续批次。`,
      );
    }
    if (stats.failures > 0) {
      const failed = stats.failedMessageIds;
      await this.options.sendToApprover(
        `筛选失败：${failed.length} 条消息未处理，已保留待重试。\n原因见日志；不会静默丢弃。`,
      );
    }
    const byId = new Map(items.map((item) => [item.messageId, item]));
    const failed = new Set(stats.failedMessageIds);
    for (const message of enriched) {
      if (failed.has(message.messageId)) continue;
      const item = byId.get(message.messageId);
      if (!item?.relevant) {
        await this.options.markProcessed(message);
        continue;
      }
      this.appendContextForScan(message);
      if (
        item.ownership === "external" &&
        (item.ownershipConfidence ?? 0) >= 0.6
      ) {
        this.options.logger.info("ignored external ownership", {
          messageId: message.messageId,
          chatId: message.chat.id,
          reason: item.ownershipReason ?? item.reason,
        });
        await this.options.markProcessed(message);
        continue;
      }
      if (this.hasMedia(message)) {
        await this.queueMediaApproval(message, item);
        await this.options.markProcessed(message);
        continue;
      }
      if (
        item.actionability === "task" &&
        item.confidence >= this.options.config.filter.minTaskConfidence
      ) {
        await this.options.taskService.ensureTask(message, item, "group_scan");
      }
      await this.options.markProcessed(message);
    }
    if (items.some((item) => item.relevant && item.ownerAttention)) {
      await this.sendOwnerDigest(enriched, items);
    }
    this.options.logger.info("polled batch classified", {
      chatId: enriched[0]?.chat.id,
      messages: stats.messages,
      batches: stats.batches,
      tokens: stats.totalTokens,
      relevant: items.filter((item) => item.relevant).length,
    });
  }

  async runManualDigest(messages: IncomingMessage[], signal?: AbortSignal): Promise<number> {
    const usable = messages.filter(
      (message) => message.senderType === "user" && message.text.trim().length > 0,
    );
    if (usable.length === 0) return 0;
    const enriched = await this.enrichFiles(usable);
    const first = enriched[0];
    const history = first
      ? this.options.chatContext
          .recent(`${first.platform}:${first.chat.id}`, 12)
          .map((item) => ({
            sender: item.senderName ?? item.senderId,
            text: item.text,
            time: item.at,
          }))
      : [];
    const { items } = await this.options.relevance().classify(enriched, signal, history);
    await this.sendOwnerDigest(enriched, items);
    return enriched.length;
  }

  private async digestWithoutFilter(messages: IncomingMessage[]): Promise<void> {
    const usable = messages.filter(
      (message) => message.senderType === "user" && message.text.trim().length > 0,
    );
    if (usable.length === 0) {
      for (const message of messages) await this.options.markProcessed(message);
      return;
    }
    await this.sendOwnerDigest(usable, []);
    for (const message of messages) await this.options.markProcessed(message);
  }

  private async sendOwnerDigest(
    messages: IncomingMessage[],
    items: Classification[],
  ): Promise<void> {
    const byId = new Map(items.map((item) => [item.messageId, item]));
    const lines: string[] = [];
    const related: IncomingMessage[] = [];
    for (const message of messages) {
      const item = byId.get(message.messageId);
      const external =
        item?.ownership === "external" && (item.ownershipConfidence ?? 0) >= 0.6;
      if (item?.relevant && !external) related.push(message);
    }
    const highlighted =
      related.length > 0
        ? related
        : items.length === 0
          ? messages.slice(0, 5)
          : [];
    const senderNames = new Map<string, string>();
    await Promise.all(
      highlighted.slice(0, 8).map(async (message) => {
        senderNames.set(message.messageId, await this.resolveSenderLabel(message));
      }),
    );
    for (const message of highlighted.slice(0, 8)) {
      const item = byId.get(message.messageId);
      const sender = senderNames.get(message.messageId) ?? message.sender.id;
      const time = formatLocalTime(message.createdAt);
      const reason = item?.reason ? `｜判断：${truncate(item.reason, 80)}` : "";
      const action = item?.actionability ? `｜类型：${item.actionability}` : "";
      lines.push(
        [
          `• ${time} ${sender}${action}${reason}`,
          `  > ${truncate(message.text.replace(/\s+/g, " "), 160)}`,
        ].join("\n"),
      );
    }
    const summary =
      related.length > 0
        ? `与你相关 ${related.length} 条，共 ${messages.length} 条`
        : `本轮 ${messages.length} 条，未识别出与本群职责强相关的消息`;
    const first = messages[0];
    const group = first
      ? (this.options.chatContext.get(`${first.platform}:${first.chat.id}`)?.chatName ??
        this.options.config.platforms.feishu.groups.find(
          (item) => item.chatId === first.chat.id,
        )?.name ??
        first.chat.name ??
        first.chat.id)
      : "未知群";
    const highlightedMessages = highlighted.slice(0, 8);
    const messageLinks = await Promise.all(
      highlightedMessages.map((message) => this.resolveMessageLink(message)),
    );
    const firstLink =
      messageLinks.find((link): link is string => Boolean(link)) ??
      (first ? await this.resolveMessageLink(first) : undefined);
    const view: NotificationView = {
      title: `群消息分析 · ${group}`,
      subtitle: summary,
      sections: highlightedMessages.map((message, index) => {
        const item = byId.get(message.messageId);
        const link = messageLinks[index];
        return {
          title: `${formatLocalTime(message.createdAt)} ${senderNames.get(message.messageId) ?? message.sender.id}`,
          ...(item?.actionability ? { meta: item.actionability } : {}),
          quote: truncate(message.text.replace(/\s+/g, " "), 160),
          ...(item?.reason ? { detail: `判断：${truncate(item.reason, 80)}` } : {}),
          ...(link ? { link: { label: "查看原消息", url: link } } : {}),
        };
      }),
      ...(first
        ? {
            link: firstLink
              ? { label: "打开原消息", url: firstLink }
              : { label: "打开群聊", url: this.chatLink(first.chat.id) },
          }
        : {}),
    };
    if (this.options.sendOwnerNotification) {
      await this.options.sendOwnerNotification(view);
    } else {
      await this.options.sendToOwner(
        [
          `群消息分析（${group}）：${summary}`,
          ...(first ? [`群聊：${this.chatLink(first.chat.id)}`] : []),
          ...lines,
        ].join("\n\n"),
      );
    }
  }

  private chatLink(chatId: string): string {
    return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
  }

  private async resolveMessageLink(message: IncomingMessage): Promise<string | undefined> {
    if (message.messageLink) return message.messageLink;
    try {
      return (await this.options.platform.fetchMessage?.(message.messageId))?.messageLink;
    } catch {
      return undefined;
    }
  }

  private async resolveSenderLabel(message: IncomingMessage): Promise<string> {
    if (message.sender.displayName) return message.sender.displayName;
    try {
      const fetched = await this.options.platform.fetchMessage?.(message.messageId);
      if (fetched?.sender.displayName) return fetched.sender.displayName;
    } catch {
      // fall through to contact lookup / id
    }
    try {
      const name = await this.options.platform.fetchUserName?.(message.sender.id);
      if (name) return name;
    } catch {
      // keep id as last resort
    }
    return message.sender.id;
  }

  private hasMedia(message: IncomingMessage): boolean {
    return (message.attachments ?? []).some(
      (attachment) => attachment.kind === "image" || attachment.kind === "file",
    );
  }

  private async queueMediaApproval(
    message: IncomingMessage,
    classification: Classification,
  ): Promise<void> {
    const taskHint = classification.task ?? {
      title: truncate(message.text.replace(/\s+/g, " ").trim() || "待分析群媒体", 60),
    };
    await this.options.taskService.ensureTask(
      message,
      {
        ...classification,
        actionability: "task",
        confidence: Math.max(classification.confidence, this.options.config.filter.minTaskConfidence),
        task: taskHint,
      },
      "group_scan",
      { autoAnalyze: false },
    );
  }

  private appendContextForScan(message: IncomingMessage): void {
    if (!this.options.config.context.enabled) return;
    if (!this.options.config.context.storeRelevantScan) return;
    this.options.chatContext.append(
      `${message.platform}:${message.chat.id}`,
      {
        messageId: message.messageId,
        senderId: message.sender.id,
        ...(message.sender.displayName ? { senderName: message.sender.displayName } : {}),
        text: message.text,
        at: message.createdAt,
        ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
        ...(message.threadId ? { threadId: message.threadId } : {}),
        mentionMe: false,
        mentionBot: false,
        origin: "scan_relevant",
      },
      {
        platform: message.platform,
        chatId: message.chat.id,
        ...(message.chat.name ? { chatName: message.chat.name } : {}),
      },
    );
  }
}

function suggestedActionLabel(actionability: Classification["actionability"]): string {
  switch (actionability) {
    case "task":
      return "转任务";
    case "question":
      return "可代答";
    case "fyi":
      return "仅知会";
    default:
      return "忽略";
  }
}

function clip(text: string, max: number, label: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[已截断：${label} 原长 ${text.length} 字符，仅显示前 ${max} 字符]`;
}
