export type ConversationKind = "group" | "dm";

export interface ConversationRef {
  channel: string;
  accountId?: string;
  kind: ConversationKind;
  externalId: string;
}

export function conversationKey(ref: ConversationRef): string {
  const account = ref.accountId?.trim() || "_";
  return `${ref.channel}:${account}:${ref.kind}:${ref.externalId}`;
}

export function conversationRefForChat(
  channel: string,
  externalId: string,
  kind: ConversationKind,
  accountId?: string,
): ConversationRef {
  return {
    channel,
    ...(accountId ? { accountId } : {}),
    kind,
    externalId,
  };
}
