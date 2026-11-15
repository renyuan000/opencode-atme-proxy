export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
    child(scope: string): Logger;
}
export interface LoggerOptions {
    scope: string;
    level?: LogLevel;
    file?: string;
}
export declare function createLogger(options: LoggerOptions): Logger;
export declare function createSilentLogger(): Logger;
