import type { AppConfig, LoadedConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { Logger } from "./logger.js";
import type { OwnerStore, OwnerBinding } from "./owner-store.js";
import type { IncomingMessage } from "./types.js";

export interface OwnerAccessServiceOptions {
  config: AppConfig;
  loaded: LoadedConfig;
  owners: OwnerStore;
  audit: AuditLog;
  logger: Logger;
  sendToOwner(text: string): Promise<boolean>;
}

export class OwnerAccessService {
  private resolvedOwner?: OwnerBinding;
  private readonly claimAttempts = new Map<
    string,
    { count: number; firstAt: number }
  >();

  constructor(private readonly options: OwnerAccessServiceOptions) {}

  init(): void {
    const feishu = this.options.config.platforms.feishu;
    const openId = feishu.me.openId ?? feishu.approvers[0]?.openId;
    if (!openId) return;
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

  reconcile(): void {
    const stored = this.options.owners.get("feishu");
    if (!this.resolvedOwner && stored) {
      this.resolvedOwner = stored;
      return;
    }
    if (!stored && this.resolvedOwner) {
      this.options.owners.set(this.resolvedOwner);
      return;
    }
    if (
      stored &&
      this.resolvedOwner &&
      stored.openId !== this.resolvedOwner.openId
    ) {
      this.options.logger.warn(
        "configured owner differs from persisted owner; using config",
        {
          configured: this.resolvedOwner.openId,
          persisted: stored.openId,
        },
      );
      this.options.owners.set(this.resolvedOwner);
    }
  }

  openId(): string | undefined {
    const feishu = this.options.config.platforms.feishu;
    return (
      this.resolvedOwner?.openId ??
      feishu.me.openId ??
      feishu.approvers[0]?.openId
    );
  }

  name(): string {
    return (
      this.resolvedOwner?.displayName ??
      this.options.config.platforms.feishu.me.name ??
      this.options.config.filter.profile.name ??
      "我"
    );
  }

  async claim(message: IncomingMessage): Promise<boolean> {
    const bootstrap = this.options.config.platforms.feishu.bootstrap;
    if (!bootstrap.allowPrivateClaim) return false;
    const claimCode = this.options.loaded.secrets.claimCode;
    if (!claimCode) return false;
    if (message.chat.kind !== "direct") return false;

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
      await this.options.sendToOwner(
        "owner 已绑定，不能通过 claim 覆盖；如需更换请重新生成 claim code 并清空 owner.json。",
      );
      return false;
    }

    const binding: OwnerBinding = {
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
    await this.options.sendToOwner(
      `已绑定你为 owner：${message.sender.displayName ?? message.sender.id}。后续 @、升级、审批都发给你。`,
    );
    return true;
  }

  load(): Promise<void> {
    return this.options.owners.load();
  }

  flush(): Promise<void> {
    return this.options.owners.flush();
  }

  private recordClaimAttempt(senderId: string): void {
    const now = Date.now();
    const entry = this.claimAttempts.get(senderId);
    if (!entry || now - entry.firstAt > 600_000) {
      this.claimAttempts.set(senderId, { count: 1, firstAt: now });
      return;
    }
    entry.count += 1;
  }

  private tooManyClaimAttempts(senderId: string): boolean {
    const entry = this.claimAttempts.get(senderId);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > 600_000) {
      this.claimAttempts.delete(senderId);
      return false;
    }
    return (
      entry.count >
      this.options.config.platforms.feishu.bootstrap.maxClaimAttemptsPer10Min
    );
  }
}
