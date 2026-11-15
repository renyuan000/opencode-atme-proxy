import type { TaskState } from "./types.js";
export declare function canTransition(from: TaskState, to: TaskState): boolean;
export declare function assertTransition(from: TaskState, to: TaskState): void;
export declare function nextStates(from: TaskState): readonly TaskState[];
export declare function isTerminal(state: TaskState): boolean;
