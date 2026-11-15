import { setTimeout as delay } from "node:timers/promises";

const ACCOUNTS_ENDPOINT = "https://accounts.feishu.cn";
const OPEN_ENDPOINT = "https://open.feishu.cn";
const APP_REGISTRATION_PATH = "/oauth/v1/app/registration";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_POLL_INTERVAL = 60;

export interface AppRegistrationBegin {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface AppRegistrationResult {
  appId: string;
  appSecret: string;
  openId?: string;
  tenantBrand?: string;
}

export interface DeviceFlowOptions {
  onWait?: (begin: AppRegistrationBegin) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function parseBeginResponse(data: Record<string, unknown>): AppRegistrationBegin {
  const userCode = typeof data.user_code === "string" ? data.user_code : "";
  const verificationUri =
    typeof data.verification_uri === "string" ? data.verification_uri : "";
  return {
    deviceCode: typeof data.device_code === "string" ? data.device_code : "",
    userCode,
    verificationUri,
    verificationUriComplete: userCode
      ? `${OPEN_ENDPOINT}/page/cli?user_code=${encodeURIComponent(userCode)}`
      : verificationUri,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : 300,
    interval: typeof data.interval === "number" ? data.interval : 5,
  };
}

export function parsePollResponse(data: Record<string, unknown>): AppRegistrationResult | undefined {
  if (data.error === "authorization_pending") return undefined;
  const appId = typeof data.client_id === "string" ? data.client_id : "";
  if (!appId) return undefined;
  const userInfo = data.user_info as Record<string, unknown> | undefined;
  return {
    appId,
    appSecret: typeof data.client_secret === "string" ? data.client_secret : "",
    ...(typeof userInfo?.open_id === "string" ? { openId: userInfo.open_id } : {}),
    ...(typeof userInfo?.tenant_brand === "string"
      ? { tenantBrand: userInfo.tenant_brand }
      : {}),
  };
}

export async function beginAppRegistration(
  options: DeviceFlowOptions = {},
): Promise<AppRegistrationBegin> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const form = new URLSearchParams();
  form.set("action", "begin");
  form.set("archetype", "PersonalAgent");
  form.set("auth_method", "client_secret");
  form.set("request_user_info", "open_id tenant_brand");

  const response = await fetchImpl(`${ACCOUNTS_ENDPOINT}${APP_REGISTRATION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok || data.error) {
    throw new Error(
      `飞书设备授权失败: ${String(data.error_description ?? data.error ?? response.status)}`,
    );
  }
  const begin = parseBeginResponse(data);
  if (!begin.deviceCode) throw new Error("飞书设备授权没有返回 device_code");
  options.onWait?.(begin);
  return begin;
}

export async function pollAppRegistration(
  begin: AppRegistrationBegin,
  options: DeviceFlowOptions = {},
): Promise<AppRegistrationResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const now = options.now ?? Date.now;
  const deadline = now() + begin.expiresIn * 1000;
  let interval = begin.interval;

  while (now() < deadline) {
    await sleep(interval * 1000);
    const form = new URLSearchParams();
    form.set("action", "poll");
    form.set("device_code", begin.deviceCode);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${ACCOUNTS_ENDPOINT}${APP_REGISTRATION_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: controller.signal,
      });
      const data = (await response.json()) as Record<string, unknown>;
      const error = typeof data.error === "string" ? data.error : "";
      if (error === "slow_down") {
        interval = Math.min(interval + 5, MAX_POLL_INTERVAL);
        continue;
      }
      if (error === "access_denied") throw new Error("你取消了飞书应用授权");
      if (error === "expired_token" || error === "invalid_grant") {
        throw new Error("飞书设备码已过期，请重新运行 setup");
      }
      if (error && error !== "authorization_pending") {
        throw new Error(`飞书授权失败: ${String(data.error_description ?? error)}`);
      }
      const result = parsePollResponse(data);
      if (result) {
        if (!result.appSecret) throw new Error("飞书授权成功但没有返回 App Secret");
        return result;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        interval = Math.min(interval + 2, MAX_POLL_INTERVAL);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("飞书授权超时，请重新运行 setup");
}

export function formatRegistrationPrompt(begin: AppRegistrationBegin): string {
  return [
    "请在飞书 App 中打开下面的链接完成应用创建：",
    `  ${begin.verificationUriComplete}`,
    begin.userCode ? `确认码：${begin.userCode}` : "",
    `有效期：${begin.expiresIn} 秒`,
  ]
    .filter(Boolean)
    .join("\n");
}
