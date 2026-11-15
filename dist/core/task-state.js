const transitions = {
    candidate: ["analyzing", "rejected", "canceled"],
    analyzing: ["needs_info", "awaiting_approval", "failed", "canceled", "candidate"],
    needs_info: ["analyzing", "canceled", "rejected"],
    awaiting_approval: ["approved", "rejected", "expired", "canceled", "done"],
    approved: ["executing", "canceled", "failed"],
    executing: ["verifying", "failed", "canceled", "approved", "awaiting_approval"],
    verifying: ["awaiting_merge", "done", "failed", "canceled", "executing", "awaiting_approval"],
    awaiting_merge: ["done", "failed", "canceled", "awaiting_approval"],
    done: [],
    rejected: [],
    failed: ["analyzing", "canceled"],
    canceled: [],
    expired: ["awaiting_approval", "canceled"],
};
export function canTransition(from, to) {
    return transitions[from].includes(to);
}
export function assertTransition(from, to) {
    if (!canTransition(from, to)) {
        throw new Error(`invalid task transition: ${from} -> ${to}`);
    }
}
export function nextStates(from) {
    return transitions[from];
}
export function isTerminal(state) {
    return transitions[state].length === 0;
}
//# sourceMappingURL=task-state.js.map