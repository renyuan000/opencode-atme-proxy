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
export declare function parseBeginResponse(data: Record<string, unknown>): AppRegistrationBegin;
export declare function parsePollResponse(data: Record<string, unknown>): AppRegistrationResult | undefined;
export declare function beginAppRegistration(options?: DeviceFlowOptions): Promise<AppRegistrationBegin>;
export declare function pollAppRegistration(begin: AppRegistrationBegin, options?: DeviceFlowOptions): Promise<AppRegistrationResult>;
export declare function formatRegistrationPrompt(begin: AppRegistrationBegin): string;
