import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export const userDir = (): string => join(homedir(), ".yggdrasil");
export const configFile = (): string => join(userDir(), "config.json");
export const stateFile = (): string => join(userDir(), "state.json");
export const metricsFile = (): string => join(userDir(), "metrics.ndjson");
export const worktreesRoot = (): string => join(userDir(), "wt");
export const logsRoot = (): string => join(userDir(), "logs");
export const profilesDir = (): string => join(userDir(), "profiles");
export const profileFile = (name: string): string =>
  join(profilesDir(), `${name}.json`);

export const worktreeFor = (repoName: string, issueId: number): string => {
  const slug = repoName.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return join(worktreesRoot(), slug, `issue-${issueId}`);
};

export const worktreeForMr = (repoName: string, mrIid: number): string => {
  const slug = repoName.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return join(worktreesRoot(), slug, `mr-${mrIid}`);
};

export const logFile = (agentId: string): string =>
  join(logsRoot(), `${agentId}.ndjson`);

export const ensureUserDirs = (): void => {
  for (const dir of [userDir(), worktreesRoot(), logsRoot(), profilesDir()]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
};
