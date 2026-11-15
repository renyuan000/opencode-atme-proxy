import type { PlatformAdapter } from "../../core/ports.js";
import type { ApprovalView, CapabilitySet, IncomingMessage, OutboundMessage, OutboundTarget } from "../../core/types.js";
import type { FeishuAdapter } from "./adapter.js";
import type { FeishuEventSource } from "./events.js";
export declare class HybridFeishuAdapter implements PlatformAdapter {
    private readonly adapter;
    private readonly events;
    readonly platform = "feishu";
    constructor(adapter: FeishuAdapter, events: FeishuEventSource);
    capabilities(): CapabilitySet;
    start(handlers: Parameters<PlatformAdapter["start"]>[0]): Promise<void>;
    stop(): Promise<void>;
    healthCheck(): Promise<{
        ok: boolean;
        detail?: string;
    }>;
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
    renderApproval(view: ApprovalView): OutboundMessage;
    verifyActor(actor: {
        platform: string;
        id: string;
        displayName?: string;
    }): Promise<boolean>;
    getBotOpenId(): string | undefined;
}
