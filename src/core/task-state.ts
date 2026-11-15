import type { TaskState } from "./types.js";

const transitions: Record<TaskState, readonly TaskState[]> = {
  candidate: ["analyzing", "rejected", "canceled"],
  analyzing: ["needs_info", "awaiting_approval", "failed", "canceled"],
  needs_info: ["analyzing", "canceled", "rejected"],
  awaiting_approval: ["approved", "rejected", "expired", "canceled", "done"],
  approved: ["executing", "canceled", "failed"],
  executing: ["verifying", "failed", "canceled"],
  verifying: ["awaiting_merge", "done", "failed", "canceled"],
  awaiting_merge: ["done", "failed", "canceled"],
  done: [],
  rejected: [],
  failed: ["analyzing", "canceled"],
  canceled: [],
  expired: ["awaiting_approval", "canceled"],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid task transition: ${from} -> ${to}`);
  }
}

export function nextStates(from: TaskState): readonly TaskState[] {
  return transitions[from];
}

export function isTerminal(state: TaskState): boolean {
  return transitions[state].length === 0;
}
