import type { AppConfig } from "./config.js";
import type { DedupStore } from "./dedup.js";
import type { ChatContextStore } from "./chat-context.js";
import type { EvidenceStore } from "./evidence-store.js";
import type { Logger } from "./logger.js";
import type { ContextOrigin } from "./chat-context.js";
import type { SenderLimiter } from "./sender-limiter.js";
import type { IncomingMessage } from "./types.js";
import { isLowValueMessage } from "./util.js";

export interface MessageIngressOptions {
  config: AppConfig;
  logger: Logger;
  dedup: DedupStore;
  chatContext: ChatContextStore;
  evidence: EvidenceStore;
  senderLimiter: SenderLimiter;
  activeMessageIds: Set<string>;
  ownerOpenId(): string | undefined;
  botOpenId(): string | undefined;
  rememberRecent(message: IncomingMessage): void;
  updateGroupSummary(platform: string, chatId: string): void;
  acknowledge?(message: IncomingMessage): Promise<void>;
  safeReply(message: IncomingMessage, text: string): Promise<boolean>;
  dispatch(message: IncomingMessage, limited: boolean, wait: boolean, force: boolean): Promise<void>;
}

export class MessageIngress {
  constructor(private readonly options: MessageIngressOptions) {}

  async handle(
    message: IncomingMessage,
    _chatName: string,
    wait = false,
    force = false,
  ): Promise<void> {
    const dedupKey = `${message.platform}:${message.messageId}`;
    if ((!force && this.options.dedup.has(dedupKey)) || this.options.activeMessageIds.has(dedupKey)) {
      return;
    }
    this.options.activeMessageIds.add(dedupKey);
    this.options.rememberRecent(message);
    const mentionBot = this.isMentionBot(message);
    const ownerId = this.options.ownerOpenId();
    const fromOwner = Boolean(ownerId) && message.sender.id === ownerId;
    const limited =
      mentionBot &&
      !force &&
      !(this.options.config.botReply.ownerBypass && fromOwner);
    if (limited && !this.options.senderLimiter.tryAcquire(message.sender.id)) {
      if (this.options.senderLimiter.shouldWarn(message.sender.id)) {
        this.options.logger.warn("sender rate limited; sending one warning", {
          senderId: message.sender.id,
          messageId: message.messageId,
        });
        await this.options.safeReply(message, this.options.config.botReply.overloadReply);
      }
      this.options.dedup.add(dedupKey);
      await this.options.dedup.flush();
      this.options.activeMessageIds.delete(dedupKey);
      return;
    }
    const mentionMe = this.isMentionMe(message);
    if ((mentionMe || mentionBot) && this.options.acknowledge) {
      void this.options.acknowledge(message).catch((error) => {
        this.options.logger.warn("failed to add acknowledgement reaction", {
          messageId: message.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    const storeOwnerGroup =
      fromOwner &&
      this.options.config.context.enabled &&
      this.options.config.context.storeOwnerGroup !== false;
    const storeAllGroup =
      this.options.config.context.storeAllGroupMessages !== false &&
      !isLowValueMessage(message.text);
    if (this.shouldStoreContext(message, mentionMe, mentionBot) || storeOwnerGroup || storeAllGroup) {
      const origin: ContextOrigin = mentionBot
        ? "mention_bot"
        : mentionMe
          ? "mention_me"
          : fromOwner
            ? "owner_group"
            : this.isMediaMessage(message)
              ? "media_placeholder"
              : "group_all";
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
          mentionMe,
          mentionBot,
          ...(message.attachments ? { attachments: message.attachments } : {}),
          origin,
        },
        {
          platform: message.platform,
          chatId: message.chat.id,
          ...(message.chat.name ? { chatName: message.chat.name } : {}),
        },
      );
      this.options.evidence.append({
        ts: message.createdAt,
        platform: message.platform,
        chatId: message.chat.id,
        ...(message.chat.name ? { chatName: message.chat.name } : {}),
        messageId: message.messageId,
        direction: "inbound",
        senderId: message.sender.id,
        ...(message.sender.displayName ? { senderName: message.sender.displayName } : {}),
        origin,
        text: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
      });
    }
    if (this.options.config.groupSession?.enabled !== false) {
      this.options.updateGroupSummary(message.platform, message.chat.id);
    }
    await this.options.dispatch(message, limited, wait, force);
  }

  private shouldStoreContext(
    message: IncomingMessage,
    mentionMe: boolean,
    mentionBot: boolean,
  ): boolean {
    if (!this.options.config.context.enabled) return false;
    if (mentionMe || mentionBot) return this.options.config.context.storeMentions;
    if (
      this.options.config.context.storeMediaPlaceholders !== false &&
      this.isMediaMessage(message)
    ) {
      return true;
    }
    return false;
  }

  private isMediaMessage(message: IncomingMessage): boolean {
    if ((message.attachments?.length ?? 0) > 0) return true;
    return /\[(图片|文件|视频|音频)[^\]]*未解析\]/.test(message.text);
  }

  private isMentionMe(message: IncomingMessage): boolean {
    const me = this.options.ownerOpenId();
    return Boolean(me) && message.mentions.some((mention) => mention.id === me);
  }

  private isMentionBot(message: IncomingMessage): boolean {
    const bot = this.options.botOpenId();
    return Boolean(bot) && message.mentions.some((mention) => mention.id === bot);
  }
}
