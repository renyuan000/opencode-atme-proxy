import type { PlatformAdapter } from "../../core/ports.js";
import type {
  ApprovalView,
  CapabilitySet,
  IncomingMessage,
  OutboundMessage,
  OutboundTarget,
  PlatformAction,
  PlatformActionResult,
} from "../../core/types.js";
import type { FeishuAdapter } from "./adapter.js";
import type { FeishuEventSource } from "./events.js";

export class HybridFeishuAdapter implements PlatformAdapter {
  readonly platform = "feishu";

  constructor(
    private readonly adapter: FeishuAdapter,
    private readonly events: FeishuEventSource,
  ) {}

  capabilities(): CapabilitySet {
    return this.adapter.capabilities();
  }

  async start(handlers: Parameters<PlatformAdapter["start"]>[0]): Promise<void> {
    await this.adapter.start(handlers);
    await this.events.start(handlers);
  }

  async stop(): Promise<void> {
    await this.events.stop();
    await this.adapter.stop();
  }

  healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return this.adapter.healthCheck();
  }

  listMessages(input: Parameters<PlatformAdapter["listMessages"]>[0]) {
    return this.adapter.listMessages(input);
  }

  send(target: OutboundTarget, message: OutboundMessage): Promise<{ messageId: string }> {
    return this.adapter.send(target, message);
  }

  reply(
    target: { chatId: string; messageId: string },
    message: OutboundMessage,
  ): Promise<{ messageId: string }> {
    return this.adapter.reply(target, message);
  }

  renderApproval(view: ApprovalView): OutboundMessage {
    return this.adapter.renderApproval(view);
  }

  renderReplyManagement(
    view: Parameters<NonNullable<PlatformAdapter["renderReplyManagement"]>>[0],
  ): OutboundMessage {
    return this.adapter.renderReplyManagement(view);
  }

  renderCancelConfirm(
    input: Parameters<NonNullable<PlatformAdapter["renderCancelConfirm"]>>[0],
  ): OutboundMessage {
    return this.adapter.renderCancelConfirm(input);
  }

  recallMessage(chatId: string, messageId: string): Promise<void> {
    return this.adapter.recallMessage(chatId, messageId);
  }

  verifyActor(actor: { platform: string; id: string; displayName?: string }): Promise<boolean> {
    return this.adapter.verifyActor(actor);
  }

  getBotOpenId(): string | undefined {
    return this.adapter.getBotOpenId();
  }
}
