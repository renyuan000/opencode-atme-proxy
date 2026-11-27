export type FilterFailureKind = "model_timeout" | "job_timeout" | "transport_error" | "output_parse" | "config_error" | "model_error" | "unknown";
export interface FilterFailure {
    kind: FilterFailureKind;
    message: string;
    model?: string;
    timeoutMs?: number;
}
export declare function classifyFilterFailure(error: unknown): FilterFailure;
export declare function describeFilterFailure(failure: FilterFailure): string;
