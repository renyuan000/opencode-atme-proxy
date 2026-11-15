export interface AppRegistrationResult {
    appId: string;
    appSecret: string;
    openId?: string;
    tenantBrand?: string;
}
export interface DeviceFlowOptions {
    onQrReady?: (info: {
        url: string;
        expireIn: number;
    }) => void;
    onStatus?: (info: {
        status: string;
        interval?: number;
    }) => void;
    signal?: AbortSignal;
}
export declare const ATME_ADDONS: {
    preset: boolean;
    scopes: {
        tenant: string[];
    };
    events: {
        items: {
            tenant: string[];
        };
    };
    callbacks: {
        items: string[];
    };
};
export declare function registerBotApp(options?: DeviceFlowOptions): Promise<AppRegistrationResult>;
