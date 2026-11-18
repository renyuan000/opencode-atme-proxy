export class OwnerAccessService {
    options;
    resolvedOwner;
    claimAttempts = new Map();
    constructor(options) {
        this.options = options;
    }
    init() {
        const feishu = this.options.config.platforms.feishu;
        const openId = feishu.me.openId ?? feishu.approvers[0]?.openId;
        if (!openId)
            return;
        this.resolvedOwner = {
            platform: "feishu",
            openId,
            ...(feishu.me.name ?? feishu.approvers[0]?.name
                ? { displayName: feishu.me.name ?? feishu.approvers[0]?.name }
                : {}),
            boundAt: Date.now(),
            method: "config",
        };
    }
    reconcile() {
        const stored = this.options.owners.get("feishu");
        if (!this.resolvedOwner && stored) {
            this.resolvedOwner = stored;
            return;
        }
        if (!stored && this.resolvedOwner) {
            this.options.owners.set(this.resolvedOwner);
            return;
        }
        if (stored &&
            this.resolvedOwner &&
            stored.openId !== this.resolvedOwner.openId) {
            this.options.logger.warn("configured owner differs from persisted owner; using config", {
                configured: this.resolvedOwner.openId,
                persisted: stored.openId,
            });
            this.options.owners.set(this.resolvedOwner);
        }
    }
    openId() {
        const feishu = this.options.config.platforms.feishu;
        return (this.resolvedOwner?.openId ??
            feishu.me.openId ??
            feishu.approvers[0]?.openId);
    }
    name() {
        return (this.resolvedOwner?.displayName ??
            this.options.config.platforms.feishu.me.name ??
            this.options.config.filter.profile.name ??
            "我");
    }
    async claim(message) {
        const bootstrap = this.options.config.platforms.feishu.bootstrap;
        if (!bootstrap.allowPrivateClaim)
            return false;
        const claimCode = this.options.loaded.secrets.claimCode;
        if (!claimCode)
            return false;
        if (message.chat.kind !== "direct")
            return false;
        const expected = claimCode.trim();
        const provided = message.text.trim();
        if (!expected || provided !== expected) {
            this.recordClaimAttempt(message.sender.id);
            return false;
        }
        if (this.tooManyClaimAttempts(message.sender.id)) {
            await this.options.sendToOwner("claim 尝试过于频繁，已暂时拒绝。");
            return false;
        }
        const existing = this.resolvedOwner ?? this.options.owners.get(message.platform);
        if (existing && existing.openId !== message.sender.id) {
            await this.options.audit.append({
                actor: message.sender,
                action: "owner_claim_rejected",
                details: { reason: "owner already bound", existing: existing.openId },
            });
            await this.options.sendToOwner("owner 已绑定，不能通过 claim 覆盖；如需更换请重新生成 claim code 并清空 owner.json。");
            return false;
        }
        const binding = {
            platform: message.platform,
            openId: message.sender.id,
            ...(message.sender.displayName
                ? { displayName: message.sender.displayName }
                : {}),
            boundAt: Date.now(),
            method: "claim",
        };
        this.options.owners.set(binding);
        await this.options.owners.flush();
        this.resolvedOwner = binding;
        this.claimAttempts.delete(message.sender.id);
        await this.options.audit.append({
            actor: message.sender,
            action: "owner_claimed",
            details: { method: "claim" },
        });
        await this.options.sendToOwner(`已绑定你为 owner：${message.sender.displayName ?? message.sender.id}。后续 @、升级、审批都发给你。`);
        return true;
    }
    load() {
        return this.options.owners.load();
    }
    flush() {
        return this.options.owners.flush();
    }
    recordClaimAttempt(senderId) {
        const now = Date.now();
        const entry = this.claimAttempts.get(senderId);
        if (!entry || now - entry.firstAt > 600_000) {
            this.claimAttempts.set(senderId, { count: 1, firstAt: now });
            return;
        }
        entry.count += 1;
    }
    tooManyClaimAttempts(senderId) {
        const entry = this.claimAttempts.get(senderId);
        if (!entry)
            return false;
        if (Date.now() - entry.firstAt > 600_000) {
            this.claimAttempts.delete(senderId);
            return false;
        }
        return (entry.count >
            this.options.config.platforms.feishu.bootstrap.maxClaimAttemptsPer10Min);
    }
}
//# sourceMappingURL=owner-access-service.js.map