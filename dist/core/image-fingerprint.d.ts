export interface ImageFingerprint {
    width: number;
    height: number;
    dhash: string;
}
export interface ImageFingerprintOptions {
    python?: string;
    script?: string;
    timeoutMs?: number;
}
export declare function hammingDistance(left: string, right: string): number;
export declare function imageFingerprint(data: Buffer, mime: string, options?: ImageFingerprintOptions): Promise<ImageFingerprint | undefined>;
