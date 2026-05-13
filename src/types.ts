import type { Provider, Issue } from "./sources/types";

export type { Provider, Issue };

export type PermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";

export type FinalizeMode = "mr" | "review" | "dry";

export interface RepoConfig {
  name: string;
  path: string;
  provider: Provider;
  remoteRepo: string;
  autoSpawn: boolean;
  autoSpawnLabel: string;
  permissionMode: PermissionMode | null;
  defaultMode: FinalizeMode | null;
  // Optional path to a Claude Code config dir (CLAUDE_CONFIG_DIR). Lets you
  // run agents under different Claude accounts per repo. null = ~/.claude default.
  claudeConfigDir: string | null;
}

export interface GlobalConfig {
  permissionMode: PermissionMode;
  maxConcurrent: number;
  pollIntervalSec: number;
  defaultMode: FinalizeMode;
  repos: RepoConfig[];
}

export type AgentStatus =
  | "queued"
  | "running"
  | "awaiting-review"
  | "done"
  | "done-dry"
  | "failed"
  | "killed";

export interface AgentEvent {
  ts: number;
  kind: "thinking" | "tool" | "text" | "usage" | "done" | "system";
  name?: string;
  brief?: string;
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  ok?: boolean;
  reason?: string;
}

export interface Agent {
  id: string;
  repoName: string;
  issueId: number;
  issueTitle: string;
  branch: string;
  worktreePath: string;
  mode: FinalizeMode;
  status: AgentStatus;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  inputTokens: number;
  outputTokens: number;
  currentTool?: string;
  lastText?: string;
  log: AgentEvent[];
  errorMessage?: string;
  mrUrl?: string;
}
