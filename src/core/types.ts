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
  key?: string;
  name?: string;
  size?: number;
}

export interface IncomingMessage {
  platform: Platform;
  messageId: string;
  messageIds?: string[];
  replyToMessageId?: string;
  chat: ChatRef;
  sender: ActorRef;
  senderType: "user" | "bot" | "system";
  text: string;
  mentions: ActorRef[];
  createdAt: number;
  threadId?: string;
  messageLink?: string;
  rawType: string;
  attachments?: AttachmentRef[];
}

export type Actionability = "task" | "question" | "fyi" | "noise";

export type AnalysisLayer =
  | "web_ui"
  | "web_api"
  | "service"
  | "pg"
  | "kafka"
  | "engine"
  | "protocol"
  | "performance"
  | "deploy"
  | "unknown";

export type PrefilterLayer = Exclude<AnalysisLayer, "unknown">;

export interface PrefilterResult {
  score: number;
  reasons: string[];
  layerHints: PrefilterLayer[];
  addressedToOther: boolean;
  mentionedOwner: boolean;
  mentionedBot: boolean;
  coreHits: string[];
  externalHits: string[];
  protocolHits: string[];
  performanceHit: boolean;
  kafkaHit: boolean;
  strongExternal: boolean;
}

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
  topic?: string;
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
  ownerAttention?: boolean;
  ownership?: "ours" | "external" | "unclear";
  ownershipConfidence?: number;
  affectedProjects?: string[];
  ownershipReason?: string;
  layer?: AnalysisLayer;
  perfTarget?: string;
  kafkaRole?: "producer" | "consumer" | "unknown";
  protocolFamily?: string;
  prefilter?: PrefilterResult;
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
  conversationId?: string;
  chatName?: string;
  messageIds: string[];
  messageLink?: string;
  approvalMessageId?: string;
  candidateMessageId?: string;
  supplements?: Array<{
    messageId: string;
    text: string;
    senderId?: string;
    senderName?: string;
    createdAt: number;
  }>;
  source: "mention_me" | "mention_bot" | "group_scan";
  requester: ActorRef;
  title: string;
  excerpt: string;
  topic?: string;
  attachments?: AttachmentRef[];
  project?: string;
  deadline?: number;
  keywords: string[];
  relevance: {
    reason: string;
    confidence: number;
  };
  dedupKey: string;
  actionability?: Actionability;
  burstMessages?: Array<{ messageId: string; text: string; at: number }>;
  lastNudgeAt?: number;
  state: TaskState;
  archivedAt?: number;
  archivedReason?: string;
  lastAnalyzedAt?: number;
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
  files?: string[];
  plan: TaskPlanStep[];
  commands: string[];
  risks: string[];
  openQuestions: string[];
  acceptanceCriteria: string[];
  estimate?: string;
  assumptions?: string[];
  checked?: string[];
  verification?: AnalysisVerification;
  model: string;
  createdAt: number;
  planHash: string;
}

export type AnalysisDrift = "none" | "minor" | "major";

export interface AnalysisVerification {
  drift: AnalysisDrift;
  reasons: string[];
  unverifiedIdentifiers: string[];
  checked: string[];
  assumptions?: string[];
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
  replyId?: string;
  actor: ActorRef;
  raw?: unknown;
}

export interface PlatformActionResult {
  ok: boolean;
  toast?: string;
  card?: unknown;
}

export interface NotificationSection {
  title: string;
  meta?: string;
  quote?: string;
  detail?: string;
  link?: { label: string; url: string };
}

export interface NotificationHeaderMeta {
  left?: string;
  right?: string;
}

export interface NotificationView {
  title: string;
  subtitle?: string;
  headerMeta?: NotificationHeaderMeta;
  sections: NotificationSection[];
  link?: { label: string; url: string };
  footer?: string;
}

export interface PendingReplySummary {
  taskId: string;
  planHash: string;
  chatLabel: string;
  senderLabel: string;
  draft: string;
  excerpt: string;
  createdAt: number;
}

export interface SentReplySummary {
  id: string;
  chatLabel: string;
  senderLabel: string;
  text: string;
  sourceText: string;
  sentAt: number;
  status: "sent" | "recalled";
}

export interface ReplyManagementView {
  pending: PendingReplySummary[];
  sent: SentReplySummary[];
}

export interface ApprovalView {
  taskId: string;
  planHash: string;
  mode: "reply" | "develop";
  title: string;
  summary: string;
  chatLabel?: string;
  sourceLink?: { label: string; url: string };
  scope?: string[];
  files?: string[];
  plan?: string[];
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
  resolution?: "approved" | "rejected" | "self" | "revised" | "expired";
  resolutionNote?: string;
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
