export class HybridFeishuAdapter {
    adapter;
    events;
    platform = "feishu";
    constructor(adapter, events) {
        this.adapter = adapter;
        this.events = events;
    }
    capabilities() {
        return this.adapter.capabilities();
    }
    async start(handlers) {
        await this.adapter.start(handlers);
        await this.events.start(handlers);
    }
    async stop() {
        await this.events.stop();
        await this.adapter.stop();
    }
    healthCheck() {
        return this.adapter.healthCheck();
    }
    listMessages(input) {
        return this.adapter.listMessages(input);
    }
    listGroups() {
        return this.adapter.listGroups();
    }
    fetchMessage(messageId) {
        return this.adapter.fetchMessage(messageId);
    }
    send(target, message) {
        return this.adapter.send(target, message);
    }
    reply(target, message) {
        return this.adapter.reply(target, message);
    }
    renderApproval(view) {
        return this.adapter.renderApproval(view);
    }
    renderReplyManagement(view) {
        return this.adapter.renderReplyManagement(view);
    }
    renderCancelConfirm(input) {
        return this.adapter.renderCancelConfirm(input);
    }
    recallMessage(chatId, messageId) {
        return this.adapter.recallMessage(chatId, messageId);
    }
    fetchResource(messageId, key, kind) {
        return this.adapter.fetchResource(messageId, key, kind);
    }
    acknowledge(messageId, emojiType) {
        return this.adapter.acknowledge(messageId, emojiType);
    }
    verifyActor(actor) {
        return this.adapter.verifyActor(actor);
    }
    getBotOpenId() {
        return this.adapter.getBotOpenId();
    }
    getBotName() {
        return this.adapter.getBotName();
    }
}
//# sourceMappingURL=hybrid.js.map