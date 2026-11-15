import type {
  ActorRef,
  ApprovalView,
  CapabilitySet,
  IncomingMessage,
  OutboundMessage,
  OutboundTarget,
  PlatformAction,
  PlatformActionResult,
} from "./types.js";

export interface AdapterHandlers {
  onMessage(message: IncomingMessage): Promise<void>;
  onAction(action: PlatformAction): Promise<PlatformActionResult>;
}

export interface ListMessagesInput {
  chatId: string;
  startTime: number;
  endTime: number;
  cursor?: string;
  maxPages: number;
  maxMessages: number;
}

export interface ListMessagesResult {
  messages: IncomingMessage[];
  nextCursor?: string;
}

export interface PlatformAdapter {
  readonly platform: string;
  capabilities(): CapabilitySet;
  start(handlers: AdapterHandlers): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  listMessages(input: ListMessagesInput): Promise<ListMessagesResult>;
  send(target: OutboundTarget, message: OutboundMessage): Promise<{ messageId: string }>;
  reply(
    target: { chatId: string; messageId: string },
    message: OutboundMessage,
  ): Promise<{ messageId: string }>;
  renderApproval(view: ApprovalView): OutboundMessage;
  verifyActor(actor: ActorRef): Promise<boolean>;
}
