import type { ActorRef, IncomingMessage, OutboundMessage, OutboundTarget, PlatformAction, PlatformActionResult } from "../../core/types.js";
import type { PlatformAdapter } from "../../core/ports.js";
import type { FeishuConfig } from "../../core/config.js";
import type { Logger } from "../../core/logger.js";
interface FeishuRawMessage {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    create_time?: string;
    parent_id?: string;
    root_id?: string;
    thread_id?: string;
    mentions?: Array<{
        key?: string;
        id?: {
            open_id?: string;
            user_id?: string;
            union_id?: string;
        };
        name?: string;
    }>;
    sender?: {
        sender_id?: {
            open_id?: string;
            user_id?: string;
            union_id?: string;
        };
        sender_type?: string;
    };
}
export declare function mapFeishuMessage(raw: FeishuRawMessage): IncomingMessage | undefined;
export interface FeishuAdapterOptions {
    config: FeishuConfig;
    appSecret: string;
    logger?: Logger;
    client?: LarkClientLike;
}
export interface LarkClientLike {
    request(params: Record<string, unknown>): Promise<any>;
}
export declare class FeishuAdapter implements PlatformAdapter {
    private readonly options;
    readonly platform = "feishu";
    private readonly logger;
    private readonly client;
    private botOpenId?;
    private handlers?;
    constructor(options: FeishuAdapterOptions);
    capabilities(): {
        realtimeMentions: boolean;
        allGroupMessages: boolean;
        groupHistory: boolean;
        directMessage: boolean;
        reply: boolean;
        interactiveCard: boolean;
        buttons: boolean;
        threads: boolean;
        attachmentsInbound: boolean;
        identityVerify: boolean;
    };
    start(handlers: Parameters<PlatformAdapter["start"]>[0]): Promise<void>;
    stop(): Promise<void>;
    healthCheck(): Promise<{
        ok: boolean;
        detail?: string;
    }>;
    getBotOpenId(): string | undefined;
    listMessages(input: Parameters<PlatformAdapter["listMessages"]>[0]): Promise<{
        nextCursor?: string | undefined;
        messages: IncomingMessage[];
    }>;
    send(target: OutboundTarget, message: OutboundMessage): Promise<{
        messageId: string;
    }>;
    reply(target: {
        chatId: string;
        messageId: string;
    }, message: OutboundMessage): Promise<{
        messageId: string;
    }>;
    renderApproval(view: Parameters<PlatformAdapter["renderApproval"]>[0]): OutboundMessage;
    verifyActor(actor: ActorRef): Promise<boolean>;
    private requireMessageId;
    private resolveBotOpenId;
}
export declare function renderApprovalCard(view: Parameters<PlatformAdapter["renderApproval"]>[0]): OutboundMessage;
export declare function parseCardAction(raw: any): PlatformAction | undefined;
export type { PlatformActionResult };
