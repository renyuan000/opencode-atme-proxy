import type { ActorRef, ApprovalView, CapabilitySet, IncomingMessage, OutboundMessage, OutboundTarget, PlatformAction, PlatformActionResult, ReplyManagementView } from "./types.js";
export interface ChatMembershipEvent {
    platform: string;
    chatId: string;
    change: "bot_added" | "bot_removed";
    actorId?: string;
    at: number;
}
export interface MessageRecalledEvent {
    platform: string;
    messageId: string;
    chatId?: string;
    at: number;
}
export interface AdapterHandlers {
    onMessage(message: IncomingMessage): Promise<void>;
    onAction(action: PlatformAction): Promise<PlatformActionResult>;
    onChatMembership?(event: ChatMembershipEvent): Promise<void>;
    onMessageRecalled?(event: MessageRecalledEvent): Promise<void>;
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
    healthCheck(): Promise<{
        ok: boolean;
        detail?: string;
    }>;
    listMessages(input: ListMessagesInput): Promise<ListMessagesResult>;
    listGroups?(): Promise<Array<{
        chatId: string;
        name?: string;
    }>>;
    send(target: OutboundTarget, message: OutboundMessage): Promise<{
        messageId: string;
    }>;
    reply(target: {
        chatId: string;
        messageId: string;
    }, message: OutboundMessage): Promise<{
        messageId: string;
    }>;
    renderApproval(view: ApprovalView): OutboundMessage;
    fetchResource?(messageId: string, key: string, kind?: "image" | "file"): Promise<{
        data: Buffer;
        mime: string;
        filename?: string;
    }>;
    acknowledge?(messageId: string, emojiType?: string): Promise<void>;
    renderReplyManagement?(view: ReplyManagementView): OutboundMessage;
    renderCancelConfirm?(input: {
        taskId: string;
        planHash: string;
        draft?: string;
    }): OutboundMessage;
    recallMessage?(chatId: string, messageId: string): Promise<void>;
    verifyActor(actor: ActorRef): Promise<boolean>;
}
