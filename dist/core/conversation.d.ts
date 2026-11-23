export type ConversationKind = "group" | "dm";
export interface ConversationRef {
    channel: string;
    accountId?: string;
    kind: ConversationKind;
    externalId: string;
}
export declare function conversationKey(ref: ConversationRef): string;
export declare function conversationRefForChat(channel: string, externalId: string, kind: ConversationKind, accountId?: string): ConversationRef;
