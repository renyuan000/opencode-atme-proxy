import { z } from "zod";
export declare const WorkspaceSchema: z.ZodDefault<z.ZodObject<{
    root: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    root: string;
}, {
    root?: string | undefined;
}>>;
export declare const AppConfigSchema: z.ZodObject<{
    version: z.ZodDefault<z.ZodNumber>;
    app: z.ZodDefault<z.ZodObject<{
        stateDir: z.ZodDefault<z.ZodString>;
        logLevel: z.ZodDefault<z.ZodEnum<["debug", "info", "warn", "error"]>>;
        logFile: z.ZodOptional<z.ZodString>;
        logToFile: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        stateDir: string;
        logLevel: "debug" | "info" | "warn" | "error";
        logToFile: boolean;
        logFile?: string | undefined;
    }, {
        stateDir?: string | undefined;
        logLevel?: "debug" | "info" | "warn" | "error" | undefined;
        logFile?: string | undefined;
        logToFile?: boolean | undefined;
    }>>;
    workspace: z.ZodOptional<z.ZodDefault<z.ZodObject<{
        root: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        root: string;
    }, {
        root?: string | undefined;
    }>>>;
    platforms: z.ZodObject<{
        feishu: z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            appId: z.ZodString;
            appSecret: z.ZodOptional<z.ZodString>;
            appSecretEnv: z.ZodDefault<z.ZodString>;
            domain: z.ZodDefault<z.ZodEnum<["feishu", "lark"]>>;
            botOpenId: z.ZodOptional<z.ZodString>;
            me: z.ZodDefault<z.ZodObject<{
                openId: z.ZodOptional<z.ZodString>;
                name: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                name?: string | undefined;
                openId?: string | undefined;
            }, {
                name?: string | undefined;
                openId?: string | undefined;
            }>>;
            approvers: z.ZodDefault<z.ZodArray<z.ZodObject<{
                openId: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                openId: string;
                name?: string | undefined;
            }, {
                openId: string;
                name?: string | undefined;
            }>, "many">>;
            bootstrap: z.ZodDefault<z.ZodObject<{
                claimCode: z.ZodOptional<z.ZodString>;
                claimCodeEnv: z.ZodDefault<z.ZodString>;
                allowPrivateClaim: z.ZodDefault<z.ZodBoolean>;
                maxClaimAttemptsPer10Min: z.ZodDefault<z.ZodNumber>;
            }, "strip", z.ZodTypeAny, {
                claimCodeEnv: string;
                allowPrivateClaim: boolean;
                maxClaimAttemptsPer10Min: number;
                claimCode?: string | undefined;
            }, {
                claimCode?: string | undefined;
                claimCodeEnv?: string | undefined;
                allowPrivateClaim?: boolean | undefined;
                maxClaimAttemptsPer10Min?: number | undefined;
            }>>;
            groups: z.ZodDefault<z.ZodArray<z.ZodObject<{
                chatId: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                enabled: z.ZodDefault<z.ZodBoolean>;
                project: z.ZodOptional<z.ZodObject<{
                    primary: z.ZodOptional<z.ZodString>;
                    core: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
                    reference: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
                    secondary: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
                }, "strip", z.ZodTypeAny, {
                    core: string[];
                    reference: string[];
                    secondary: string[];
                    primary?: string | undefined;
                }, {
                    primary?: string | undefined;
                    core?: string[] | undefined;
                    reference?: string[] | undefined;
                    secondary?: string[] | undefined;
                }>>;
                workspace: z.ZodOptional<z.ZodObject<{
                    root: z.ZodOptional<z.ZodString>;
                    projects: z.ZodDefault<z.ZodArray<z.ZodObject<{
                        name: z.ZodString;
                        path: z.ZodString;
                        description: z.ZodOptional<z.ZodString>;
                    }, "strip", z.ZodTypeAny, {
                        path: string;
                        name: string;
                        description?: string | undefined;
                    }, {
                        path: string;
                        name: string;
                        description?: string | undefined;
                    }>, "many">>;
                    docs: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
                    autoDiscover: z.ZodOptional<z.ZodBoolean>;
                }, "strip", z.ZodTypeAny, {
                    projects: {
                        path: string;
                        name: string;
                        description?: string | undefined;
                    }[];
                    docs: string[];
                    root?: string | undefined;
                    autoDiscover?: boolean | undefined;
                }, {
                    root?: string | undefined;
                    projects?: {
                        path: string;
                        name: string;
                        description?: string | undefined;
                    }[] | undefined;
                    docs?: string[] | undefined;
                    autoDiscover?: boolean | undefined;
                }>>;
                responsibility: z.ZodOptional<z.ZodDefault<z.ZodObject<{
                    summary: z.ZodDefault<z.ZodString>;
                    owns: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
                    dependsOn: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
                    excludes: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
                    notes: z.ZodDefault<z.ZodString>;
                }, "strip", z.ZodTypeAny, {
                    summary: string;
                    owns: string[];
                    dependsOn: string[];
                    excludes: string[];
                    notes: string;
                }, {
                    summary?: string | undefined;
                    owns?: string[] | undefined;
                    dependsOn?: string[] | undefined;
                    excludes?: string[] | undefined;
                    notes?: string | undefined;
                }>>>;
            }, "strip", z.ZodTypeAny, {
                chatId: string;
                enabled: boolean;
                name?: string | undefined;
                project?: {
                    core: string[];
                    reference: string[];
                    secondary: string[];
                    primary?: string | undefined;
                } | undefined;
                workspace?: {
                    projects: {
                        path: string;
                        name: string;
                        description?: string | undefined;
                    }[];
                    docs: string[];
                    root?: string | undefined;
                    autoDiscover?: boolean | undefined;
                } | undefined;
                responsibility?: {
                    summary: string;
                    owns: string[];
                    dependsOn: string[];
                    excludes: string[];
                    notes: string;
                } | undefined;
            }, {
                chatId: string;
                name?: string | undefined;
                enabled?: boolean | undefined;
                project?: {
                    primary?: string | undefined;
                    core?: string[] | undefined;
                    reference?: string[] | undefined;
                    secondary?: string[] | undefined;
                } | undefined;
                workspace?: {
                    root?: string | undefined;
                    projects?: {
                        path: string;
                        name: string;
                        description?: string | undefined;
                    }[] | undefined;
                    docs?: string[] | undefined;
                    autoDiscover?: boolean | undefined;
                } | undefined;
                responsibility?: {
                    summary?: string | undefined;
                    owns?: string[] | undefined;
                    dependsOn?: string[] | undefined;
                    excludes?: string[] | undefined;
                    notes?: string | undefined;
                } | undefined;
            }>, "many">>;
            receiveAllGroupMessages: z.ZodDefault<z.ZodBoolean>;
            autoSyncGroups: z.ZodOptional<z.ZodBoolean>;
            rateLimit: z.ZodDefault<z.ZodObject<{
                sendPerSecond: z.ZodDefault<z.ZodNumber>;
                burst: z.ZodDefault<z.ZodNumber>;
            }, "strip", z.ZodTypeAny, {
                sendPerSecond: number;
                burst: number;
            }, {
                sendPerSecond?: number | undefined;
                burst?: number | undefined;
            }>>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            appId: string;
            appSecretEnv: string;
            domain: "feishu" | "lark";
            me: {
                name?: string | undefined;
                openId?: string | undefined;
            };
            approvers: {
                openId: string;
                name?: string | undefined;
            }[];
            bootstrap: {
                claimCodeEnv: string;
                allowPrivateClaim: boolean;
                maxClaimAttemptsPer10Min: number;
                claimCode?: string | undefined;
            };
            groups: {
                chatId: string;
                enabled: boolean;
                name?: string | undefined;
                project?: {
                    core: string[];
                    reference: string[];
                    secondary: string[];
                    primary?: string | undefined;
                } | undefined;
                workspace?: {
                    projects: {
                        path: string;
                        name: string;
                        description?: string | undefined;
                    }[];
                    docs: string[];
                    root?: string | undefined;
                    autoDiscover?: boolean | undefined;
                } | undefined;
                responsibility?: {
                    summary: string;
                    owns: string[];
                    dependsOn: string[];
                    excludes: string[];
                    notes: string;
                } | undefined;
            }[];
            receiveAllGroupMessages: boolean;
            rateLimit: {
                sendPerSecond: number;
                burst: number;
            };
            appSecret?: string | undefined;
            botOpenId?: string | undefined;
            autoSyncGroups?: boolean | undefined;
        }, {
            appId: string;
            enabled?: boolean | undefined;
            appSecret?: string | undefined;
            appSecretEnv?: string | undefined;
            domain?: "feishu" | "lark" | undefined;
            botOpenId?: string | undefined;
            me?: {
                name?: string | undefined;
                openId?: string | undefined;
            } | undefined;
            approvers?: {
                openId: string;
                name?: string | undefined;
            }[] | undefined;
            bootstrap?: {
                claimCode?: string | undefined;
                claimCodeEnv?: string | undefined;
                allowPrivateClaim?: boolean | undefined;
                maxClaimAttemptsPer10Min?: number | undefined;
            } | undefined;
            groups?: {
                chatId: string;
                name?: string | undefined;
                enabled?: boolean | undefined;
                project?: {
                    primary?: string | undefined;
                    core?: string[] | undefined;
                    reference?: string[] | undefined;
                    secondary?: string[] | undefined;
                } | undefined;
                workspace?: {
                    root?: string | undefined;
                    projects?: {
                        path: string;
                        name: string;
                        description?: string | undefined;
                    }[] | undefined;
                    docs?: string[] | undefined;
                    autoDiscover?: boolean | undefined;
                } | undefined;
                responsibility?: {
                    summary?: string | undefined;
                    owns?: string[] | undefined;
                    dependsOn?: string[] | undefined;
                    excludes?: string[] | undefined;
                    notes?: string | undefined;
                } | undefined;
            }[] | undefined;
            receiveAllGroupMessages?: boolean | undefined;
            autoSyncGroups?: boolean | undefined;
            rateLimit?: {
                sendPerSecond?: number | undefined;
                burst?: number | undefined;
            } | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        feishu: {
            enabled: boolean;
            appId: string;
            appSecretEnv: string;
            domain: "feishu" | "lark";
            me: {
                name?: string | undefined;
                openId?: string | undefined;
            };
            approvers: {
                openId: string;
                name?: string | undefined;
            }[];
            bootstrap: {
                claimCodeEnv: string;
                allowPrivateClaim: boolean;
                maxClaimAttemptsPer10Min: number;
                claimCode?: string | undefined;
            };
            groups: {
                chatId: string;
                enabled: boolean;
                name?: string | undefined;
                project?: {
                    core: string[];
                    reference: string[];
                    secondary: string[];
                    primary?: string | undefined;
                } | undefined;
                workspace?: {
                    projects: {
                        path: string;
                        name: string;
                        description?: string | undefined;
                    }[];
                    docs: string[];
                    root?: string | undefined;
                    autoDiscover?: boolean | undefined;
                } | undefined;
                responsibility?: {
                    summary: string;
                    owns: string[];
                    dependsOn: string[];
                    excludes: string[];
                    notes: string;
                } | undefined;
            }[];
            receiveAllGroupMessages: boolean;
            rateLimit: {
                sendPerSecond: number;
                burst: number;
            };
            appSecret?: string | undefined;
            botOpenId?: string | undefined;
            autoSyncGroups?: boolean | undefined;
        };
    }, {
        feishu: {
            appId: string;
            enabled?: boolean | undefined;
            appSecret?: string | undefined;
            appSecretEnv?: string | undefined;
            domain?: "feishu" | "lark" | undefined;
            botOpenId?: string | undefined;
            me?: {
                name?: string | undefined;
                openId?: string | undefined;
            } | undefined;
            approvers?: {
                openId: string;
                name?: string | undefined;
            }[] | undefined;
            bootstrap?: {
                claimCode?: string | undefined;
                claimCodeEnv?: string | undefined;
                allowPrivateClaim?: boolean | undefined;
                maxClaimAttemptsPer10Min?: number | undefined;
            } | undefined;
            groups?: {
                chatId: string;
                name?: string | undefined;
                enabled?: boolean | undefined;
                project?: {
                    primary?: string | undefined;
                    core?: string[] | undefined;
                    reference?: string[] | undefined;
                    secondary?: string[] | undefined;
                } | undefined;
                workspace?: {
                    root?: string | undefined;
                    projects?: {
                        path: string;
                        name: string;
                        description?: string | undefined;
                    }[] | undefined;
                    docs?: string[] | undefined;
                    autoDiscover?: boolean | undefined;
                } | undefined;
                responsibility?: {
                    summary?: string | undefined;
                    owns?: string[] | undefined;
                    dependsOn?: string[] | undefined;
                    excludes?: string[] | undefined;
                    notes?: string | undefined;
                } | undefined;
            }[] | undefined;
            receiveAllGroupMessages?: boolean | undefined;
            autoSyncGroups?: boolean | undefined;
            rateLimit?: {
                sendPerSecond?: number | undefined;
                burst?: number | undefined;
            } | undefined;
        };
    }>;
    polling: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        intervalSeconds: z.ZodDefault<z.ZodNumber>;
        pageSize: z.ZodDefault<z.ZodNumber>;
        maxPages: z.ZodDefault<z.ZodNumber>;
        lookbackSeconds: z.ZodDefault<z.ZodNumber>;
        overlapSeconds: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        lookbackSeconds: number;
        intervalSeconds: number;
        pageSize: number;
        maxPages: number;
        overlapSeconds: number;
    }, {
        enabled?: boolean | undefined;
        lookbackSeconds?: number | undefined;
        intervalSeconds?: number | undefined;
        pageSize?: number | undefined;
        maxPages?: number | undefined;
        overlapSeconds?: number | undefined;
    }>>;
    recovery: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        onStartup: z.ZodDefault<z.ZodBoolean>;
        lookbackSeconds: z.ZodDefault<z.ZodNumber>;
        maxMessages: z.ZodDefault<z.ZodNumber>;
        maxPlainMessagesPerGroup: z.ZodDefault<z.ZodNumber>;
        includeMentions: z.ZodDefault<z.ZodBoolean>;
        includeRelevantPlain: z.ZodDefault<z.ZodBoolean>;
        resumeTasks: z.ZodDefault<z.ZodBoolean>;
        resumeMaxAgeDays: z.ZodDefault<z.ZodNumber>;
        staleRunningMinutes: z.ZodDefault<z.ZodNumber>;
        nudgeHours: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        onStartup: boolean;
        lookbackSeconds: number;
        maxMessages: number;
        maxPlainMessagesPerGroup: number;
        includeMentions: boolean;
        includeRelevantPlain: boolean;
        resumeTasks: boolean;
        resumeMaxAgeDays: number;
        staleRunningMinutes: number;
        nudgeHours: number;
    }, {
        enabled?: boolean | undefined;
        onStartup?: boolean | undefined;
        lookbackSeconds?: number | undefined;
        maxMessages?: number | undefined;
        maxPlainMessagesPerGroup?: number | undefined;
        includeMentions?: boolean | undefined;
        includeRelevantPlain?: boolean | undefined;
        resumeTasks?: boolean | undefined;
        resumeMaxAgeDays?: number | undefined;
        staleRunningMinutes?: number | undefined;
        nudgeHours?: number | undefined;
    }>>;
    filter: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        mode: z.ZodDefault<z.ZodEnum<["opencode", "external"]>>;
        keywordPrefilter: z.ZodDefault<z.ZodBoolean>;
        baseUrl: z.ZodOptional<z.ZodString>;
        apiKey: z.ZodOptional<z.ZodString>;
        apiKeyEnv: z.ZodDefault<z.ZodString>;
        model: z.ZodDefault<z.ZodString>;
        maxMessagesPerBatch: z.ZodDefault<z.ZodNumber>;
        maxCharsPerMessage: z.ZodDefault<z.ZodNumber>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
        minTaskConfidence: z.ZodDefault<z.ZodNumber>;
        minReviewConfidence: z.ZodDefault<z.ZodNumber>;
        profile: z.ZodDefault<z.ZodObject<{
            name: z.ZodDefault<z.ZodString>;
            role: z.ZodDefault<z.ZodString>;
            keywords: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            excludeKeywords: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            projects: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            tasks: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            name: string;
            projects: string[];
            role: string;
            keywords: string[];
            excludeKeywords: string[];
            tasks: string[];
        }, {
            name?: string | undefined;
            projects?: string[] | undefined;
            role?: string | undefined;
            keywords?: string[] | undefined;
            excludeKeywords?: string[] | undefined;
            tasks?: string[] | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        mode: "opencode" | "external";
        enabled: boolean;
        keywordPrefilter: boolean;
        apiKeyEnv: string;
        model: string;
        maxMessagesPerBatch: number;
        maxCharsPerMessage: number;
        timeoutMs: number;
        minTaskConfidence: number;
        minReviewConfidence: number;
        profile: {
            name: string;
            projects: string[];
            role: string;
            keywords: string[];
            excludeKeywords: string[];
            tasks: string[];
        };
        baseUrl?: string | undefined;
        apiKey?: string | undefined;
    }, {
        mode?: "opencode" | "external" | undefined;
        enabled?: boolean | undefined;
        keywordPrefilter?: boolean | undefined;
        baseUrl?: string | undefined;
        apiKey?: string | undefined;
        apiKeyEnv?: string | undefined;
        model?: string | undefined;
        maxMessagesPerBatch?: number | undefined;
        maxCharsPerMessage?: number | undefined;
        timeoutMs?: number | undefined;
        minTaskConfidence?: number | undefined;
        minReviewConfidence?: number | undefined;
        profile?: {
            name?: string | undefined;
            projects?: string[] | undefined;
            role?: string | undefined;
            keywords?: string[] | undefined;
            excludeKeywords?: string[] | undefined;
            tasks?: string[] | undefined;
        } | undefined;
    }>>;
    analysis: z.ZodDefault<z.ZodObject<{
        mode: z.ZodDefault<z.ZodEnum<["main_agent", "cheap_model"]>>;
        model: z.ZodOptional<z.ZodObject<{
            providerID: z.ZodString;
            modelID: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            providerID: string;
            modelID: string;
        }, {
            providerID: string;
            modelID: string;
        }>>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        mode: "main_agent" | "cheap_model";
        timeoutMs: number;
        model?: {
            providerID: string;
            modelID: string;
        } | undefined;
    }, {
        mode?: "main_agent" | "cheap_model" | undefined;
        model?: {
            providerID: string;
            modelID: string;
        } | undefined;
        timeoutMs?: number | undefined;
    }>>;
    opencode: z.ZodDefault<z.ZodObject<{
        baseUrl: z.ZodDefault<z.ZodString>;
        password: z.ZodOptional<z.ZodString>;
        passwordEnv: z.ZodDefault<z.ZodString>;
        sessionTitlePrefix: z.ZodDefault<z.ZodString>;
        agent: z.ZodOptional<z.ZodString>;
        analysisAgent: z.ZodOptional<z.ZodString>;
        executionAgent: z.ZodOptional<z.ZodString>;
        replyModel: z.ZodOptional<z.ZodObject<{
            providerID: z.ZodString;
            modelID: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            providerID: string;
            modelID: string;
        }, {
            providerID: string;
            modelID: string;
        }>>;
        keepSessions: z.ZodDefault<z.ZodBoolean>;
        sessionListVisible: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        baseUrl: string;
        passwordEnv: string;
        sessionTitlePrefix: string;
        keepSessions: boolean;
        sessionListVisible: boolean;
        password?: string | undefined;
        agent?: string | undefined;
        analysisAgent?: string | undefined;
        executionAgent?: string | undefined;
        replyModel?: {
            providerID: string;
            modelID: string;
        } | undefined;
    }, {
        baseUrl?: string | undefined;
        password?: string | undefined;
        passwordEnv?: string | undefined;
        sessionTitlePrefix?: string | undefined;
        agent?: string | undefined;
        analysisAgent?: string | undefined;
        executionAgent?: string | undefined;
        replyModel?: {
            providerID: string;
            modelID: string;
        } | undefined;
        keepSessions?: boolean | undefined;
        sessionListVisible?: boolean | undefined;
    }>>;
    subagents: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        analyst: z.ZodDefault<z.ZodString>;
        executor: z.ZodDefault<z.ZodString>;
        reviewer: z.ZodDefault<z.ZodString>;
        maxChildrenPerTask: z.ZodDefault<z.ZodNumber>;
        maxChildrenGlobal: z.ZodDefault<z.ZodNumber>;
        depth: z.ZodDefault<z.ZodNumber>;
        archiveAfterDays: z.ZodDefault<z.ZodNumber>;
        deleteAfterDays: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        analyst: string;
        executor: string;
        reviewer: string;
        maxChildrenPerTask: number;
        maxChildrenGlobal: number;
        depth: number;
        archiveAfterDays: number;
        deleteAfterDays: number;
    }, {
        enabled?: boolean | undefined;
        analyst?: string | undefined;
        executor?: string | undefined;
        reviewer?: string | undefined;
        maxChildrenPerTask?: number | undefined;
        maxChildrenGlobal?: number | undefined;
        depth?: number | undefined;
        archiveAfterDays?: number | undefined;
        deleteAfterDays?: number | undefined;
    }>>;
    directChat: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        onlyOwner: z.ZodDefault<z.ZodBoolean>;
        notifyBlocked: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        onlyOwner: boolean;
        notifyBlocked?: boolean | undefined;
    }, {
        enabled?: boolean | undefined;
        onlyOwner?: boolean | undefined;
        notifyBlocked?: boolean | undefined;
    }>>;
    context: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        maxMessagesPerChat: z.ZodDefault<z.ZodNumber>;
        maxCharsPerMessage: z.ZodDefault<z.ZodNumber>;
        ttlDays: z.ZodDefault<z.ZodNumber>;
        maxChats: z.ZodDefault<z.ZodNumber>;
        storeAnalysisSnippets: z.ZodDefault<z.ZodBoolean>;
        includeInAnalysis: z.ZodDefault<z.ZodBoolean>;
        storeMentions: z.ZodDefault<z.ZodBoolean>;
        storeRelevantScan: z.ZodDefault<z.ZodBoolean>;
        storeMediaPlaceholders: z.ZodOptional<z.ZodBoolean>;
        storeAllGroupMessages: z.ZodOptional<z.ZodBoolean>;
        storeOwnerDm: z.ZodDefault<z.ZodBoolean>;
        storeOwnerGroup: z.ZodOptional<z.ZodBoolean>;
        burstWindowSeconds: z.ZodDefault<z.ZodNumber>;
        burstWaitMs: z.ZodDefault<z.ZodNumber>;
        burstMaxMessages: z.ZodDefault<z.ZodNumber>;
        burstMaxChars: z.ZodDefault<z.ZodNumber>;
        burstGrouping: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        maxCharsPerMessage: number;
        maxMessagesPerChat: number;
        ttlDays: number;
        maxChats: number;
        storeAnalysisSnippets: boolean;
        includeInAnalysis: boolean;
        storeMentions: boolean;
        storeRelevantScan: boolean;
        storeOwnerDm: boolean;
        burstWindowSeconds: number;
        burstWaitMs: number;
        burstMaxMessages: number;
        burstMaxChars: number;
        burstGrouping: boolean;
        storeMediaPlaceholders?: boolean | undefined;
        storeAllGroupMessages?: boolean | undefined;
        storeOwnerGroup?: boolean | undefined;
    }, {
        enabled?: boolean | undefined;
        maxCharsPerMessage?: number | undefined;
        maxMessagesPerChat?: number | undefined;
        ttlDays?: number | undefined;
        maxChats?: number | undefined;
        storeAnalysisSnippets?: boolean | undefined;
        includeInAnalysis?: boolean | undefined;
        storeMentions?: boolean | undefined;
        storeRelevantScan?: boolean | undefined;
        storeMediaPlaceholders?: boolean | undefined;
        storeAllGroupMessages?: boolean | undefined;
        storeOwnerDm?: boolean | undefined;
        storeOwnerGroup?: boolean | undefined;
        burstWindowSeconds?: number | undefined;
        burstWaitMs?: number | undefined;
        burstMaxMessages?: number | undefined;
        burstMaxChars?: number | undefined;
        burstGrouping?: boolean | undefined;
    }>>;
    evidence: z.ZodOptional<z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        retentionDays: z.ZodDefault<z.ZodNumber>;
        maxChars: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        retentionDays: number;
        maxChars: number;
    }, {
        enabled?: boolean | undefined;
        retentionDays?: number | undefined;
        maxChars?: number | undefined;
    }>>>;
    groupSession: z.ZodOptional<z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        summaryEveryMessages: z.ZodDefault<z.ZodNumber>;
        summaryMaxChars: z.ZodDefault<z.ZodNumber>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        timeoutMs: number;
        summaryEveryMessages: number;
        summaryMaxChars: number;
    }, {
        enabled?: boolean | undefined;
        timeoutMs?: number | undefined;
        summaryEveryMessages?: number | undefined;
        summaryMaxChars?: number | undefined;
    }>>>;
    memory: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        extract: z.ZodDefault<z.ZodBoolean>;
        maxEntries: z.ZodDefault<z.ZodNumber>;
        ttlDays: z.ZodDefault<z.ZodNumber>;
        pinnedKinds: z.ZodDefault<z.ZodArray<z.ZodEnum<["task", "decision", "fact", "preference", "deadline", "outcome"]>, "many">>;
        injectLimit: z.ZodDefault<z.ZodNumber>;
        injectMaxChars: z.ZodDefault<z.ZodNumber>;
        includeInAnalysis: z.ZodDefault<z.ZodBoolean>;
        autoExtractFromMentions: z.ZodDefault<z.ZodBoolean>;
        autoExtractFromAnalysis: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        ttlDays: number;
        includeInAnalysis: boolean;
        extract: boolean;
        maxEntries: number;
        pinnedKinds: ("task" | "decision" | "fact" | "preference" | "deadline" | "outcome")[];
        injectLimit: number;
        injectMaxChars: number;
        autoExtractFromMentions: boolean;
        autoExtractFromAnalysis: boolean;
    }, {
        enabled?: boolean | undefined;
        ttlDays?: number | undefined;
        includeInAnalysis?: boolean | undefined;
        extract?: boolean | undefined;
        maxEntries?: number | undefined;
        pinnedKinds?: ("task" | "decision" | "fact" | "preference" | "deadline" | "outcome")[] | undefined;
        injectLimit?: number | undefined;
        injectMaxChars?: number | undefined;
        autoExtractFromMentions?: boolean | undefined;
        autoExtractFromAnalysis?: boolean | undefined;
    }>>;
    project: z.ZodDefault<z.ZodObject<{
        mode: z.ZodDefault<z.ZodEnum<["auto", "explicit"]>>;
        id: z.ZodOptional<z.ZodString>;
        worktree: z.ZodOptional<z.ZodString>;
        allowlist: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        fallbackWorktree: z.ZodOptional<z.ZodString>;
        recentSessions: z.ZodDefault<z.ZodNumber>;
        maxAgeDays: z.ZodDefault<z.ZodNumber>;
        cacheSeconds: z.ZodDefault<z.ZodNumber>;
        bindChat: z.ZodDefault<z.ZodBoolean>;
        includeRecentSessionTitles: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        mode: "auto" | "explicit";
        allowlist: string[];
        recentSessions: number;
        maxAgeDays: number;
        cacheSeconds: number;
        bindChat: boolean;
        includeRecentSessionTitles: number;
        id?: string | undefined;
        worktree?: string | undefined;
        fallbackWorktree?: string | undefined;
    }, {
        mode?: "auto" | "explicit" | undefined;
        id?: string | undefined;
        worktree?: string | undefined;
        allowlist?: string[] | undefined;
        fallbackWorktree?: string | undefined;
        recentSessions?: number | undefined;
        maxAgeDays?: number | undefined;
        cacheSeconds?: number | undefined;
        bindChat?: boolean | undefined;
        includeRecentSessionTitles?: number | undefined;
    }>>;
    botReply: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        allowNoReply: z.ZodDefault<z.ZodBoolean>;
        escalateWhenUnsure: z.ZodDefault<z.ZodBoolean>;
        analyzeBeforeEscalate: z.ZodDefault<z.ZodBoolean>;
        minAnswerConfidence: z.ZodDefault<z.ZodNumber>;
        decisionMentionText: z.ZodDefault<z.ZodString>;
        maxQuestionChars: z.ZodDefault<z.ZodNumber>;
        perSenderPerMinute: z.ZodDefault<z.ZodNumber>;
        perSenderConcurrent: z.ZodDefault<z.ZodNumber>;
        cooldownSeconds: z.ZodDefault<z.ZodNumber>;
        ownerBypass: z.ZodDefault<z.ZodBoolean>;
        overloadReply: z.ZodDefault<z.ZodString>;
        maxMessagesPerSenderPerRun: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        allowNoReply: boolean;
        escalateWhenUnsure: boolean;
        analyzeBeforeEscalate: boolean;
        minAnswerConfidence: number;
        decisionMentionText: string;
        maxQuestionChars: number;
        perSenderPerMinute: number;
        perSenderConcurrent: number;
        cooldownSeconds: number;
        ownerBypass: boolean;
        overloadReply: string;
        maxMessagesPerSenderPerRun: number;
    }, {
        enabled?: boolean | undefined;
        allowNoReply?: boolean | undefined;
        escalateWhenUnsure?: boolean | undefined;
        analyzeBeforeEscalate?: boolean | undefined;
        minAnswerConfidence?: number | undefined;
        decisionMentionText?: string | undefined;
        maxQuestionChars?: number | undefined;
        perSenderPerMinute?: number | undefined;
        perSenderConcurrent?: number | undefined;
        cooldownSeconds?: number | undefined;
        ownerBypass?: boolean | undefined;
        overloadReply?: string | undefined;
        maxMessagesPerSenderPerRun?: number | undefined;
    }>>;
    reply: z.ZodDefault<z.ZodObject<{
        defaultStyle: z.ZodDefault<z.ZodEnum<["concise", "detailed"]>>;
        maxChars: z.ZodDefault<z.ZodNumber>;
        detailMaxChars: z.ZodDefault<z.ZodNumber>;
        detailTriggers: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        requireApprovalForMentionMe: z.ZodDefault<z.ZodBoolean>;
        acknowledgeLongTasks: z.ZodDefault<z.ZodBoolean>;
        ackDelayMs: z.ZodDefault<z.ZodNumber>;
        ackText: z.ZodDefault<z.ZodString>;
        ackReaction: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        maxChars: number;
        defaultStyle: "concise" | "detailed";
        detailMaxChars: number;
        detailTriggers: string[];
        requireApprovalForMentionMe: boolean;
        acknowledgeLongTasks: boolean;
        ackDelayMs: number;
        ackText: string;
        ackReaction?: string | undefined;
    }, {
        maxChars?: number | undefined;
        defaultStyle?: "concise" | "detailed" | undefined;
        detailMaxChars?: number | undefined;
        detailTriggers?: string[] | undefined;
        requireApprovalForMentionMe?: boolean | undefined;
        acknowledgeLongTasks?: boolean | undefined;
        ackDelayMs?: number | undefined;
        ackText?: string | undefined;
        ackReaction?: string | undefined;
    }>>;
    concurrency: z.ZodDefault<z.ZodObject<{
        global: z.ZodDefault<z.ZodNumber>;
        mentionConcurrency: z.ZodDefault<z.ZodNumber>;
        scanConcurrency: z.ZodDefault<z.ZodNumber>;
        perChat: z.ZodDefault<z.ZodNumber>;
        maxQueue: z.ZodDefault<z.ZodNumber>;
        mentionTimeoutMs: z.ZodDefault<z.ZodNumber>;
        intentTimeoutMs: z.ZodOptional<z.ZodNumber>;
        replyTimeoutMs: z.ZodOptional<z.ZodNumber>;
        scanTimeoutMs: z.ZodDefault<z.ZodNumber>;
        analysisTimeoutMs: z.ZodDefault<z.ZodNumber>;
        maxRetries: z.ZodDefault<z.ZodNumber>;
        retryDelayMs: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        global: number;
        mentionConcurrency: number;
        scanConcurrency: number;
        perChat: number;
        maxQueue: number;
        mentionTimeoutMs: number;
        scanTimeoutMs: number;
        analysisTimeoutMs: number;
        maxRetries: number;
        retryDelayMs: number;
        intentTimeoutMs?: number | undefined;
        replyTimeoutMs?: number | undefined;
    }, {
        global?: number | undefined;
        mentionConcurrency?: number | undefined;
        scanConcurrency?: number | undefined;
        perChat?: number | undefined;
        maxQueue?: number | undefined;
        mentionTimeoutMs?: number | undefined;
        intentTimeoutMs?: number | undefined;
        replyTimeoutMs?: number | undefined;
        scanTimeoutMs?: number | undefined;
        analysisTimeoutMs?: number | undefined;
        maxRetries?: number | undefined;
        retryDelayMs?: number | undefined;
    }>>;
    repos: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        path: z.ZodString;
        defaultBranch: z.ZodDefault<z.ZodString>;
        testCommand: z.ZodDefault<z.ZodArray<z.ZodArray<z.ZodString, "many">, "many">>;
        lintCommand: z.ZodDefault<z.ZodArray<z.ZodArray<z.ZodString, "many">, "many">>;
        allowPush: z.ZodDefault<z.ZodBoolean>;
        allowMerge: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        path: string;
        id: string;
        defaultBranch: string;
        testCommand: string[][];
        lintCommand: string[][];
        allowPush: boolean;
        allowMerge: boolean;
    }, {
        path: string;
        id: string;
        defaultBranch?: string | undefined;
        testCommand?: string[][] | undefined;
        lintCommand?: string[][] | undefined;
        allowPush?: boolean | undefined;
        allowMerge?: boolean | undefined;
    }>, "many">>;
    policy: z.ZodDefault<z.ZodObject<{
        defaultDenyGroups: z.ZodDefault<z.ZodBoolean>;
        autoReplyOnMention: z.ZodDefault<z.ZodBoolean>;
        groupWriteBack: z.ZodDefault<z.ZodBoolean>;
        requireMergeApproval: z.ZodDefault<z.ZodBoolean>;
        allowExternalModel: z.ZodDefault<z.ZodBoolean>;
        autoAnalyzeTasks: z.ZodDefault<z.ZodBoolean>;
        maxConcurrentExecutions: z.ZodDefault<z.ZodNumber>;
        approvalTimeoutHours: z.ZodDefault<z.ZodNumber>;
        executionTimeoutMinutes: z.ZodDefault<z.ZodNumber>;
        maxExecutionRetries: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        defaultDenyGroups: boolean;
        autoReplyOnMention: boolean;
        groupWriteBack: boolean;
        requireMergeApproval: boolean;
        allowExternalModel: boolean;
        autoAnalyzeTasks: boolean;
        maxConcurrentExecutions: number;
        approvalTimeoutHours: number;
        executionTimeoutMinutes: number;
        maxExecutionRetries: number;
    }, {
        defaultDenyGroups?: boolean | undefined;
        autoReplyOnMention?: boolean | undefined;
        groupWriteBack?: boolean | undefined;
        requireMergeApproval?: boolean | undefined;
        allowExternalModel?: boolean | undefined;
        autoAnalyzeTasks?: boolean | undefined;
        maxConcurrentExecutions?: number | undefined;
        approvalTimeoutHours?: number | undefined;
        executionTimeoutMinutes?: number | undefined;
        maxExecutionRetries?: number | undefined;
    }>>;
    budget: z.ZodDefault<z.ZodObject<{
        maxMessagesPerRun: z.ZodDefault<z.ZodNumber>;
        maxTokensPerRun: z.ZodDefault<z.ZodNumber>;
        maxExecutionsPerDay: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        maxTokensPerRun: number;
        maxMessagesPerRun: number;
        maxExecutionsPerDay: number;
    }, {
        maxTokensPerRun?: number | undefined;
        maxMessagesPerRun?: number | undefined;
        maxExecutionsPerDay?: number | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    filter: {
        mode: "opencode" | "external";
        enabled: boolean;
        keywordPrefilter: boolean;
        apiKeyEnv: string;
        model: string;
        maxMessagesPerBatch: number;
        maxCharsPerMessage: number;
        timeoutMs: number;
        minTaskConfidence: number;
        minReviewConfidence: number;
        profile: {
            name: string;
            projects: string[];
            role: string;
            keywords: string[];
            excludeKeywords: string[];
            tasks: string[];
        };
        baseUrl?: string | undefined;
        apiKey?: string | undefined;
    };
    project: {
        mode: "auto" | "explicit";
        allowlist: string[];
        recentSessions: number;
        maxAgeDays: number;
        cacheSeconds: number;
        bindChat: boolean;
        includeRecentSessionTitles: number;
        id?: string | undefined;
        worktree?: string | undefined;
        fallbackWorktree?: string | undefined;
    };
    opencode: {
        baseUrl: string;
        passwordEnv: string;
        sessionTitlePrefix: string;
        keepSessions: boolean;
        sessionListVisible: boolean;
        password?: string | undefined;
        agent?: string | undefined;
        analysisAgent?: string | undefined;
        executionAgent?: string | undefined;
        replyModel?: {
            providerID: string;
            modelID: string;
        } | undefined;
    };
    version: number;
    app: {
        stateDir: string;
        logLevel: "debug" | "info" | "warn" | "error";
        logToFile: boolean;
        logFile?: string | undefined;
    };
    platforms: {
        feishu: {
            enabled: boolean;
            appId: string;
            appSecretEnv: string;
            domain: "feishu" | "lark";
            me: {
                name?: string | undefined;
                openId?: string | undefined;
            };
            approvers: {
                openId: string;
                name?: string | undefined;
            }[];
            bootstrap: {
                claimCodeEnv: string;
                allowPrivateClaim: boolean;
                maxClaimAttemptsPer10Min: number;
                claimCode?: string | undefined;
            };
            groups: {
                chatId: string;
                enabled: boolean;
                name?: string | undefined;
                project?: {
                    core: string[];
                    reference: string[];
                    secondary: string[];
                    primary?: string | undefined;
                } | undefined;
                workspace?: {
                    projects: {
                        path: string;
                        name: string;
                        description?: string | undefined;
                    }[];
                    docs: string[];
                    root?: string | undefined;
                    autoDiscover?: boolean | undefined;
                } | undefined;
                responsibility?: {
                    summary: string;
                    owns: string[];
                    dependsOn: string[];
                    excludes: string[];
                    notes: string;
                } | undefined;
            }[];
            receiveAllGroupMessages: boolean;
            rateLimit: {
                sendPerSecond: number;
                burst: number;
            };
            appSecret?: string | undefined;
            botOpenId?: string | undefined;
            autoSyncGroups?: boolean | undefined;
        };
    };
    polling: {
        enabled: boolean;
        lookbackSeconds: number;
        intervalSeconds: number;
        pageSize: number;
        maxPages: number;
        overlapSeconds: number;
    };
    recovery: {
        enabled: boolean;
        onStartup: boolean;
        lookbackSeconds: number;
        maxMessages: number;
        maxPlainMessagesPerGroup: number;
        includeMentions: boolean;
        includeRelevantPlain: boolean;
        resumeTasks: boolean;
        resumeMaxAgeDays: number;
        staleRunningMinutes: number;
        nudgeHours: number;
    };
    analysis: {
        mode: "main_agent" | "cheap_model";
        timeoutMs: number;
        model?: {
            providerID: string;
            modelID: string;
        } | undefined;
    };
    subagents: {
        enabled: boolean;
        analyst: string;
        executor: string;
        reviewer: string;
        maxChildrenPerTask: number;
        maxChildrenGlobal: number;
        depth: number;
        archiveAfterDays: number;
        deleteAfterDays: number;
    };
    directChat: {
        enabled: boolean;
        onlyOwner: boolean;
        notifyBlocked?: boolean | undefined;
    };
    context: {
        enabled: boolean;
        maxCharsPerMessage: number;
        maxMessagesPerChat: number;
        ttlDays: number;
        maxChats: number;
        storeAnalysisSnippets: boolean;
        includeInAnalysis: boolean;
        storeMentions: boolean;
        storeRelevantScan: boolean;
        storeOwnerDm: boolean;
        burstWindowSeconds: number;
        burstWaitMs: number;
        burstMaxMessages: number;
        burstMaxChars: number;
        burstGrouping: boolean;
        storeMediaPlaceholders?: boolean | undefined;
        storeAllGroupMessages?: boolean | undefined;
        storeOwnerGroup?: boolean | undefined;
    };
    memory: {
        enabled: boolean;
        ttlDays: number;
        includeInAnalysis: boolean;
        extract: boolean;
        maxEntries: number;
        pinnedKinds: ("task" | "decision" | "fact" | "preference" | "deadline" | "outcome")[];
        injectLimit: number;
        injectMaxChars: number;
        autoExtractFromMentions: boolean;
        autoExtractFromAnalysis: boolean;
    };
    botReply: {
        enabled: boolean;
        allowNoReply: boolean;
        escalateWhenUnsure: boolean;
        analyzeBeforeEscalate: boolean;
        minAnswerConfidence: number;
        decisionMentionText: string;
        maxQuestionChars: number;
        perSenderPerMinute: number;
        perSenderConcurrent: number;
        cooldownSeconds: number;
        ownerBypass: boolean;
        overloadReply: string;
        maxMessagesPerSenderPerRun: number;
    };
    reply: {
        maxChars: number;
        defaultStyle: "concise" | "detailed";
        detailMaxChars: number;
        detailTriggers: string[];
        requireApprovalForMentionMe: boolean;
        acknowledgeLongTasks: boolean;
        ackDelayMs: number;
        ackText: string;
        ackReaction?: string | undefined;
    };
    concurrency: {
        global: number;
        mentionConcurrency: number;
        scanConcurrency: number;
        perChat: number;
        maxQueue: number;
        mentionTimeoutMs: number;
        scanTimeoutMs: number;
        analysisTimeoutMs: number;
        maxRetries: number;
        retryDelayMs: number;
        intentTimeoutMs?: number | undefined;
        replyTimeoutMs?: number | undefined;
    };
    repos: {
        path: string;
        id: string;
        defaultBranch: string;
        testCommand: string[][];
        lintCommand: string[][];
        allowPush: boolean;
        allowMerge: boolean;
    }[];
    policy: {
        defaultDenyGroups: boolean;
        autoReplyOnMention: boolean;
        groupWriteBack: boolean;
        requireMergeApproval: boolean;
        allowExternalModel: boolean;
        autoAnalyzeTasks: boolean;
        maxConcurrentExecutions: number;
        approvalTimeoutHours: number;
        executionTimeoutMinutes: number;
        maxExecutionRetries: number;
    };
    budget: {
        maxTokensPerRun: number;
        maxMessagesPerRun: number;
        maxExecutionsPerDay: number;
    };
    workspace?: {
        root: string;
    } | undefined;
    evidence?: {
        enabled: boolean;
        retentionDays: number;
        maxChars: number;
    } | undefined;
    groupSession?: {
        enabled: boolean;
        timeoutMs: number;
        summaryEveryMessages: number;
        summaryMaxChars: number;
    } | undefined;
}, {
    platforms: {
        feishu: {
            appId: string;
            enabled?: boolean | undefined;
            appSecret?: string | undefined;
            appSecretEnv?: string | undefined;
            domain?: "feishu" | "lark" | undefined;
            botOpenId?: string | undefined;
            me?: {
                name?: string | undefined;
                openId?: string | undefined;
            } | undefined;
            approvers?: {
                openId: string;
                name?: string | undefined;
            }[] | undefined;
            bootstrap?: {
                claimCode?: string | undefined;
                claimCodeEnv?: string | undefined;
                allowPrivateClaim?: boolean | undefined;
                maxClaimAttemptsPer10Min?: number | undefined;
            } | undefined;
            groups?: {
                chatId: string;
                name?: string | undefined;
                enabled?: boolean | undefined;
                project?: {
                    primary?: string | undefined;
                    core?: string[] | undefined;
                    reference?: string[] | undefined;
                    secondary?: string[] | undefined;
                } | undefined;
                workspace?: {
                    root?: string | undefined;
                    projects?: {
                        path: string;
                        name: string;
                        description?: string | undefined;
                    }[] | undefined;
                    docs?: string[] | undefined;
                    autoDiscover?: boolean | undefined;
                } | undefined;
                responsibility?: {
                    summary?: string | undefined;
                    owns?: string[] | undefined;
                    dependsOn?: string[] | undefined;
                    excludes?: string[] | undefined;
                    notes?: string | undefined;
                } | undefined;
            }[] | undefined;
            receiveAllGroupMessages?: boolean | undefined;
            autoSyncGroups?: boolean | undefined;
            rateLimit?: {
                sendPerSecond?: number | undefined;
                burst?: number | undefined;
            } | undefined;
        };
    };
    filter?: {
        mode?: "opencode" | "external" | undefined;
        enabled?: boolean | undefined;
        keywordPrefilter?: boolean | undefined;
        baseUrl?: string | undefined;
        apiKey?: string | undefined;
        apiKeyEnv?: string | undefined;
        model?: string | undefined;
        maxMessagesPerBatch?: number | undefined;
        maxCharsPerMessage?: number | undefined;
        timeoutMs?: number | undefined;
        minTaskConfidence?: number | undefined;
        minReviewConfidence?: number | undefined;
        profile?: {
            name?: string | undefined;
            projects?: string[] | undefined;
            role?: string | undefined;
            keywords?: string[] | undefined;
            excludeKeywords?: string[] | undefined;
            tasks?: string[] | undefined;
        } | undefined;
    } | undefined;
    project?: {
        mode?: "auto" | "explicit" | undefined;
        id?: string | undefined;
        worktree?: string | undefined;
        allowlist?: string[] | undefined;
        fallbackWorktree?: string | undefined;
        recentSessions?: number | undefined;
        maxAgeDays?: number | undefined;
        cacheSeconds?: number | undefined;
        bindChat?: boolean | undefined;
        includeRecentSessionTitles?: number | undefined;
    } | undefined;
    workspace?: {
        root?: string | undefined;
    } | undefined;
    opencode?: {
        baseUrl?: string | undefined;
        password?: string | undefined;
        passwordEnv?: string | undefined;
        sessionTitlePrefix?: string | undefined;
        agent?: string | undefined;
        analysisAgent?: string | undefined;
        executionAgent?: string | undefined;
        replyModel?: {
            providerID: string;
            modelID: string;
        } | undefined;
        keepSessions?: boolean | undefined;
        sessionListVisible?: boolean | undefined;
    } | undefined;
    version?: number | undefined;
    app?: {
        stateDir?: string | undefined;
        logLevel?: "debug" | "info" | "warn" | "error" | undefined;
        logFile?: string | undefined;
        logToFile?: boolean | undefined;
    } | undefined;
    polling?: {
        enabled?: boolean | undefined;
        lookbackSeconds?: number | undefined;
        intervalSeconds?: number | undefined;
        pageSize?: number | undefined;
        maxPages?: number | undefined;
        overlapSeconds?: number | undefined;
    } | undefined;
    recovery?: {
        enabled?: boolean | undefined;
        onStartup?: boolean | undefined;
        lookbackSeconds?: number | undefined;
        maxMessages?: number | undefined;
        maxPlainMessagesPerGroup?: number | undefined;
        includeMentions?: boolean | undefined;
        includeRelevantPlain?: boolean | undefined;
        resumeTasks?: boolean | undefined;
        resumeMaxAgeDays?: number | undefined;
        staleRunningMinutes?: number | undefined;
        nudgeHours?: number | undefined;
    } | undefined;
    analysis?: {
        mode?: "main_agent" | "cheap_model" | undefined;
        model?: {
            providerID: string;
            modelID: string;
        } | undefined;
        timeoutMs?: number | undefined;
    } | undefined;
    subagents?: {
        enabled?: boolean | undefined;
        analyst?: string | undefined;
        executor?: string | undefined;
        reviewer?: string | undefined;
        maxChildrenPerTask?: number | undefined;
        maxChildrenGlobal?: number | undefined;
        depth?: number | undefined;
        archiveAfterDays?: number | undefined;
        deleteAfterDays?: number | undefined;
    } | undefined;
    directChat?: {
        enabled?: boolean | undefined;
        onlyOwner?: boolean | undefined;
        notifyBlocked?: boolean | undefined;
    } | undefined;
    context?: {
        enabled?: boolean | undefined;
        maxCharsPerMessage?: number | undefined;
        maxMessagesPerChat?: number | undefined;
        ttlDays?: number | undefined;
        maxChats?: number | undefined;
        storeAnalysisSnippets?: boolean | undefined;
        includeInAnalysis?: boolean | undefined;
        storeMentions?: boolean | undefined;
        storeRelevantScan?: boolean | undefined;
        storeMediaPlaceholders?: boolean | undefined;
        storeAllGroupMessages?: boolean | undefined;
        storeOwnerDm?: boolean | undefined;
        storeOwnerGroup?: boolean | undefined;
        burstWindowSeconds?: number | undefined;
        burstWaitMs?: number | undefined;
        burstMaxMessages?: number | undefined;
        burstMaxChars?: number | undefined;
        burstGrouping?: boolean | undefined;
    } | undefined;
    evidence?: {
        enabled?: boolean | undefined;
        retentionDays?: number | undefined;
        maxChars?: number | undefined;
    } | undefined;
    groupSession?: {
        enabled?: boolean | undefined;
        timeoutMs?: number | undefined;
        summaryEveryMessages?: number | undefined;
        summaryMaxChars?: number | undefined;
    } | undefined;
    memory?: {
        enabled?: boolean | undefined;
        ttlDays?: number | undefined;
        includeInAnalysis?: boolean | undefined;
        extract?: boolean | undefined;
        maxEntries?: number | undefined;
        pinnedKinds?: ("task" | "decision" | "fact" | "preference" | "deadline" | "outcome")[] | undefined;
        injectLimit?: number | undefined;
        injectMaxChars?: number | undefined;
        autoExtractFromMentions?: boolean | undefined;
        autoExtractFromAnalysis?: boolean | undefined;
    } | undefined;
    botReply?: {
        enabled?: boolean | undefined;
        allowNoReply?: boolean | undefined;
        escalateWhenUnsure?: boolean | undefined;
        analyzeBeforeEscalate?: boolean | undefined;
        minAnswerConfidence?: number | undefined;
        decisionMentionText?: string | undefined;
        maxQuestionChars?: number | undefined;
        perSenderPerMinute?: number | undefined;
        perSenderConcurrent?: number | undefined;
        cooldownSeconds?: number | undefined;
        ownerBypass?: boolean | undefined;
        overloadReply?: string | undefined;
        maxMessagesPerSenderPerRun?: number | undefined;
    } | undefined;
    reply?: {
        maxChars?: number | undefined;
        defaultStyle?: "concise" | "detailed" | undefined;
        detailMaxChars?: number | undefined;
        detailTriggers?: string[] | undefined;
        requireApprovalForMentionMe?: boolean | undefined;
        acknowledgeLongTasks?: boolean | undefined;
        ackDelayMs?: number | undefined;
        ackText?: string | undefined;
        ackReaction?: string | undefined;
    } | undefined;
    concurrency?: {
        global?: number | undefined;
        mentionConcurrency?: number | undefined;
        scanConcurrency?: number | undefined;
        perChat?: number | undefined;
        maxQueue?: number | undefined;
        mentionTimeoutMs?: number | undefined;
        intentTimeoutMs?: number | undefined;
        replyTimeoutMs?: number | undefined;
        scanTimeoutMs?: number | undefined;
        analysisTimeoutMs?: number | undefined;
        maxRetries?: number | undefined;
        retryDelayMs?: number | undefined;
    } | undefined;
    repos?: {
        path: string;
        id: string;
        defaultBranch?: string | undefined;
        testCommand?: string[][] | undefined;
        lintCommand?: string[][] | undefined;
        allowPush?: boolean | undefined;
        allowMerge?: boolean | undefined;
    }[] | undefined;
    policy?: {
        defaultDenyGroups?: boolean | undefined;
        autoReplyOnMention?: boolean | undefined;
        groupWriteBack?: boolean | undefined;
        requireMergeApproval?: boolean | undefined;
        allowExternalModel?: boolean | undefined;
        autoAnalyzeTasks?: boolean | undefined;
        maxConcurrentExecutions?: number | undefined;
        approvalTimeoutHours?: number | undefined;
        executionTimeoutMinutes?: number | undefined;
        maxExecutionRetries?: number | undefined;
    } | undefined;
    budget?: {
        maxTokensPerRun?: number | undefined;
        maxMessagesPerRun?: number | undefined;
        maxExecutionsPerDay?: number | undefined;
    } | undefined;
}>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type FeishuConfig = AppConfig["platforms"]["feishu"];
export type RepoConfig = AppConfig["repos"][number];
export interface Secrets {
    appSecret?: string;
    filterApiKey?: string;
    opencodePassword?: string;
    claimCode?: string;
}
export interface LoadedConfig {
    config: AppConfig;
    secrets: Secrets;
    path: string;
}
export interface LoadConfigOptions {
    path?: string;
    env?: NodeJS.ProcessEnv;
    enforcePermissions?: boolean;
}
export declare function defaultConfigPath(env?: NodeJS.ProcessEnv): string;
export declare function loadConfig(options?: LoadConfigOptions): Promise<LoadedConfig>;
export declare function resolveStateDir(config: AppConfig): string;
export declare function resolveLogFile(config: AppConfig): string | undefined;
