export interface WizardDefaults {
    configPath?: string;
    envPath?: string;
    nonInteractive?: boolean;
}
export declare function runSetup(defaults?: WizardDefaults): Promise<void>;
export interface DoctorCheck {
    ok: boolean;
    label: string;
    detail?: string;
    fix?: string;
}
export declare function runDoctor(configPath?: string): Promise<DoctorCheck[]>;
