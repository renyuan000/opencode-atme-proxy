export function conversationKey(ref) {
    const account = ref.accountId?.trim() || "_";
    return `${ref.channel}:${account}:${ref.kind}:${ref.externalId}`;
}
export function conversationRefForChat(channel, externalId, kind, accountId) {
    return {
        channel,
        ...(accountId ? { accountId } : {}),
        kind,
        externalId,
    };
}
//# sourceMappingURL=conversation.js.map