import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { toErrorMessage } from "./util.js";

export interface ProjectCandidate {
  id: string;
  worktree: string;
  name?: string;
  vcs: boolean;
  updatedAt: number;
}

export interface ProjectSelection {
  project: ProjectCandidate;
  reason: string;
  score: number;
}

export interface ProjectResolverOptions {
  client: OpencodeClient;
  logger?: Logger;
  allowlist: string[];
  explicitProjectId?: string;
  explicitWorktree?: string;
  fallbackWorktree?: string;
  recentSessions?: number;
  maxAgeDays?: number;
}

const DEFAULT_MAX_AGE_DAYS = 30;

export class ProjectResolver {
  private readonly logger: Logger;

  constructor(private readonly options: ProjectResolverOptions) {
    this.logger = options.logger ?? createLogger({ scope: "project" });
  }

  async resolve(): Promise<ProjectSelection | undefined> {
    if (this.options.explicitWorktree) {
      return {
        project: {
          id: "explicit",
          worktree: this.options.explicitWorktree,
          vcs: true,
          updatedAt: Date.now(),
        },
        reason: "explicit worktree from config",
        score: 100,
      };
    }

    const projects = await this.listProjects();
    const active = projects.filter(isActiveProject);
    if (active.length === 0) return undefined;

    if (this.options.explicitProjectId) {
      const match = active.find((project) => project.id === this.options.explicitProjectId);
      if (match) {
        return { project: match, reason: "explicit project id", score: 100 };
      }
      this.logger.warn("explicit project id not found; falling back", {
        projectId: this.options.explicitProjectId,
      });
    }

    const sessionScores = await this.scoreByRecentSessions(active);
    const ranked = active
      .map((project) => {
        const sessionScore = sessionScores.get(project.id) ?? 0;
        const recency = recencyScore(project.updatedAt, this.maxAgeDays());
        const allowBonus = this.isAllowed(project.worktree) ? 5 : 0;
        return {
          project,
          score: sessionScore + recency + allowBonus,
          reason:
            sessionScore > 0
              ? `recent session (${sessionScore.toFixed(1)}) + project recency (${recency.toFixed(1)})`
              : `project recency (${recency.toFixed(1)})`,
        };
      })
      .sort((a, b) => b.score - a.score || b.project.updatedAt - a.project.updatedAt);

    const best = ranked[0];
    if (!best) return undefined;
    if (!this.isAllowed(best.project.worktree)) {
      this.logger.warn("resolved project is outside allowlist; refusing", {
        worktree: best.project.worktree,
      });
      return undefined;
    }
    return best;
  }

  async resolveWorktree(): Promise<string | undefined> {
    const selection = await this.resolve();
    if (selection) return selection.project.worktree;
    if (this.options.fallbackWorktree) {
      return this.options.fallbackWorktree;
    }
    return undefined;
  }

  private maxAgeDays(): number {
    return this.options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  }

  private isAllowed(worktree: string): boolean {
    if (this.options.allowlist.length === 0) return true;
    const normalized = resolve(worktree);
    return this.options.allowlist.some((root) => {
      const rootPath = resolve(root);
      return normalized === rootPath || normalized.startsWith(rootPath + sep);
    });
  }

  private async listProjects(): Promise<ProjectCandidate[]> {
    try {
      const result = await this.options.client.project.list({});
      if (result.error || !result.data) {
        this.logger.warn("failed to list projects", { error: formatError(result.error) });
        return [];
      }
      return result.data
        .filter((project) => typeof project.worktree === "string" && project.worktree.length > 0)
        .map((project) => ({
          id: project.id,
          worktree: project.worktree,
          ...(project.name ? { name: project.name } : {}),
          vcs: project.vcs === "git",
          updatedAt: project.time?.updated ?? project.time?.created ?? 0,
        }));
    } catch (error) {
      this.logger.warn("failed to list projects", { error: toErrorMessage(error) });
      return [];
    }
  }

  private async scoreByRecentSessions(projects: ProjectCandidate[]): Promise<Map<string, number>> {
    const scores = new Map<string, number>();
    const byId = new Map(projects.map((project) => [project.id, project]));
    try {
      const result = await this.options.client.experimental.session.list({
        limit: this.options.recentSessions ?? 20,
      });
      if (result.error || !result.data) return scores;
      for (const session of result.data) {
        const projectID = session.projectID;
        if (!projectID || !byId.has(projectID)) continue;
        const ts = session.time?.updated ?? session.time?.created ?? 0;
        if (!isRecent(ts, this.maxAgeDays())) continue;
        const score = recencyScore(ts, this.maxAgeDays()) * 2;
        if (score > (scores.get(projectID) ?? 0)) scores.set(projectID, score);
      }
    } catch (error) {
      this.logger.warn("failed to list sessions for project scoring", {
        error: toErrorMessage(error),
      });
    }
    return scores;
  }
}

export function isActiveProject(project: ProjectCandidate): boolean {
  return project.vcs && project.worktree !== "/" && project.worktree !== homedir();
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function recencyScore(updatedAt: number, maxAgeDays: number): number {
  if (!updatedAt) return 0;
  const ageDays = (Date.now() - updatedAt) / 86_400_000;
  if (ageDays < 0) return 10;
  if (ageDays > maxAgeDays) return 0;
  return 10 * (1 - ageDays / maxAgeDays);
}

export function isRecent(updatedAt: number, maxAgeDays: number): boolean {
  if (!updatedAt) return false;
  const ageDays = (Date.now() - updatedAt) / 86_400_000;
  return ageDays >= 0 && ageDays <= maxAgeDays;
}

export function candidateLogFields(selection: ProjectSelection | undefined): Record<string, unknown> {
  if (!selection) return { project: "none" };
  return {
    projectId: selection.project.id,
    worktree: selection.project.worktree,
    name: selection.project.name,
    reason: selection.reason,
    score: Number(selection.score.toFixed(2)),
  };
}

function formatError(error: unknown): string {
  if (!error) return "unknown error";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
