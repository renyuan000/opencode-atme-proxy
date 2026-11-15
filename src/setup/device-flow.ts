import * as Lark from "@larksuiteoapi/node-sdk";

export interface AppRegistrationResult {
  appId: string;
  appSecret: string;
  openId?: string;
  tenantBrand?: string;
}

export interface DeviceFlowOptions {
  onQrReady?: (info: { url: string; expireIn: number }) => void;
  onStatus?: (info: { status: string; interval?: number }) => void;
  signal?: AbortSignal;
}

export const ATME_ADDONS = {
  preset: false,
  scopes: {
    tenant: [
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message:send_as_bot",
      "im:message.p2p_msg:readonly",
      "im:resource",
      "contact:user.base:readonly",
    ],
  },
  events: {
    items: {
      tenant: ["im.message.receive_v1"],
    },
  },
  callbacks: {
    items: ["card.action.trigger"],
  },
};

export async function registerBotApp(
  options: DeviceFlowOptions = {},
): Promise<AppRegistrationResult> {
  const result = await Lark.registerApp({
    source: "opencode-atme-proxy",
    onQRCodeReady: (info) => options.onQrReady?.(info),
    onStatusChange: (info) => options.onStatus?.(info),
    ...(options.signal ? { signal: options.signal } : {}),
    appPreset: {
      name: "atme 研发任务助手",
      desc: "接管飞书群里的 @我 / @机器人 消息，识别研发任务，经批准后交给 OpenCode 执行。",
    },
    addons: ATME_ADDONS,
    createOnly: true,
  });
  if (!result.client_id || !result.client_secret) {
    throw new Error("飞书创建应用成功但没有返回 App ID 或 App Secret");
  }
  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    ...(result.user_info?.open_id ? { openId: result.user_info.open_id } : {}),
    ...(result.user_info?.tenant_brand
      ? { tenantBrand: result.user_info.tenant_brand }
      : {}),
  };
}
