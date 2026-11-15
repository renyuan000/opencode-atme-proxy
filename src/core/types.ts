export type Platform = string;

export type TaskState =
  | "candidate"
  | "analyzing"
  | "needs_info"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "verifying"
  | "awaiting_merge"
  | "done"
  | "rejected"
  | "failed"
  | "canceled"
  | "expired";

export interface ActorRef {
  platform: Platform;
  id: string;
  displayName?: string;
}

export interface ChatRef {
  id: string;
  kind: "group" | "direct";
  name?: string;
}

export interface AttachmentRef {
  kind: "image" | "file" | "audio" | "video";
  name?: string;
  size?: number;
}

export interface IncomingMessage {
  platform: Platform;
  messageId: string;
  chat: ChatRef;
  sender: ActorRef;
  senderType: "user" | "bot" | "system";
  text: string;
  mentions: ActorRef[];
  createdAt: number;
  threadId?: string;
  rawType: string;
  attachments?: AttachmentRef[];
}

export type Actionability = "task" | "question" | "fyi" | "noise";

export type BotReplyAction = "answer" | "need_decision" | "notify_owner" | "no_reply";

export type BotMessageKind =
  | "question"
  | "task"
  | "reminder"
  | "notification"
  | "chat"
  | "other";

export interface BotIntent {
  action: BotReplyAction;
  kind: BotMessageKind;
  style: "concise" | "detailed";
  confidence: number;
  reason: string;
  summary?: string;
  suggestedAction?: string;
  needsAction?: boolean;
  question?: string;
}

export interface TaskHint {
  title: string;
  project?: string;
  deadline?: number;
  requester?: string;
  acceptanceHint?: string;
}

export interface Classification {
  messageId: string;
  relevant: boolean;
  actionability: Actionability;
  reason: string;
  confidence: number;
  keywordHit: boolean;
  task?: TaskHint;
}

export interface FilterStats {
  messages: number;
  batches: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  model: string;
  failures: number;
  failedMessageIds: string[];
}

export interface TaskRecord {
  id: string;
  platform: Platform;
  chatId: string;
  chatName?: string;
  messageIds: string[];
  source: "mention_me" | "mention_bot" | "group_scan";
  requester: ActorRef;
  title: string;
  excerpt: string;
  project?: string;
  deadline?: number;
  keywords: string[];
  relevance: {
    reason: string;
    confidence: number;
  };
  dedupKey: string;
  actionability?: Actionability;
  lastNudgeAt?: number;
  state: TaskState;
  createdAt: number;
  updatedAt: number;
}

export interface TaskPlanStep {
  step: string;
  detail?: string;
}

export interface TaskAnalysis {
  taskId: string;
  version: number;
  needsInfo: boolean;
  goal: string;
  scope: string[];
  outOfScope: string[];
  repos: string[];
  plan: TaskPlanStep[];
  commands: string[];
  risks: string[];
  openQuestions: string[];
  acceptanceCriteria: string[];
  estimate?: string;
  model: string;
  createdAt: number;
  planHash: string;
}

export type ApprovalKind = "reply" | "develop" | "merge" | "push";
export type ApprovalDecision = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRecord {
  taskId: string;
  analysisVersion: number;
  planHash: string;
  kind: ApprovalKind;
  decision: ApprovalDecision;
  approvedBy?: ActorRef;
  decidedAt?: number;
  note?: string;
  createdAt: number;
}

export interface ExecutionRecord {
  taskId: string;
  approvalPlanHash: string;
  repoId: string;
  worktree: string;
  branch: string;
  baseCommit: string;
  status: "running" | "verifying" | "succeeded" | "failed" | "canceled";
  commands: string[];
  testResult?: { passed: boolean; summary: string };
  diffStat?: string;
  prUrl?: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface AuditEvent {
  id: string;
  ts: number;
  actor: ActorRef | { system: true };
  action: string;
  taskId?: string;
  details: Record<string, unknown>;
}

export interface PlatformAction {
  platform: Platform;
  actionId: string;
  taskId: string;
  planHash?: string;
  action: string;
  chatId?: string;
  messageId?: string;
  actor: ActorRef;
  raw?: unknown;
}

export interface PlatformActionResult {
  ok: boolean;
  toast?: string;
}

export interface ApprovalView {
  taskId: string;
  planHash: string;
  mode: "reply" | "develop";
  title: string;
  summary: string;
  draft?: string;
  chatId?: string;
  sourceMessageId?: string;
  senderId?: string;
  repo: string;
  baseBranch: string;
  targetBranch: string;
  commands: string[];
  risks: string[];
  acceptanceCriteria: string[];
  openQuestions: string[];
}

export type OutboundMessage =
  | {
      kind: "text";
      text: string;
      quoteMessageId?: string;
      mentions?: Array<{ id: string; name?: string }>;
      uuid?: string;
    }
  | { kind: "card"; card: unknown; uuid?: string }
  | { kind: "menu"; text: string; options: Array<{ id: string; label: string }>; uuid?: string };

export type OutboundTarget =
  | { kind: "chat"; chatId: string }
  | { kind: "user"; userId: string };

export interface CapabilitySet {
  realtimeMentions: boolean;
  allGroupMessages: boolean;
  groupHistory: boolean;
  directMessage: boolean;
  reply: boolean;
  interactiveCard: boolean;
  buttons: boolean;
  threads: boolean;
  attachmentsInbound: boolean;
  identityVerify: boolean;
}

export class QueueFullError extends Error {
  constructor(message = "queue is full") {
    super(message);
    this.name = "QueueFullError";
  }
}

export class QueueClosedError extends Error {
  constructor(message = "queue is closed") {
    super(message);
    this.name = "QueueClosedError";
  }
}
