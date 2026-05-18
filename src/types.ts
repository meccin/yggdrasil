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
  // Tool gating (claude `--allowed-tools` / `--disallowed-tools`). null on the
  // repo means "inherit the global default"; an array (even empty) means full
  // override. See DEFAULT_ALLOWED_TOOLS in config.ts.
  allowedTools: string[] | null;
  disallowedTools: string[] | null;
  // Path to a Claude Code settings JSON forwarded via `--settings`. Same shape
  // as ~/.claude/settings.json (permissions.allow/deny/ask blocks supported).
  settingsPath: string | null;
  // Profile name resolved against ~/.yggdrasil/profiles/<name>.json. null on
  // the repo means "inherit the global default"; an explicit empty string is
  // not used. When neither global nor repo references a profile, the agent
  // runs a single classic prompt via buildPrompt().
  profile: string | null;
}

export interface GlobalConfig {
  permissionMode: PermissionMode;
  maxConcurrent: number;
  pollIntervalSec: number;
  defaultMode: FinalizeMode;
  allowedTools: string[];
  disallowedTools: string[];
  settingsPath: string | null;
  // Fire a desktop notification when an agent transitions to a terminal
  // status (done / done-dry / awaiting-review / failed / killed). Lets the
  // user close the TUI without losing awareness. Default: true.
  notifications: boolean;
  // Optional default profile name (resolved against ~/.yggdrasil/profiles/).
  // Repo-level `profile` overrides this. null = no pipeline (classic prompt).
  profile: string | null;
  // Max open issues fetched per repo per refresh. Sources paginate up to this.
  // Default 200, clamped to [50, 2000].
  maxIssuesPerRepo: number;
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
  // Set when the agent is running a profile pipeline. 0-based index of the
  // step currently executing (or just finished). undefined for classic runs
  // and terminal agents whose final state wasn't captured before the field
  // was cleared.
  currentStep?: number;
  totalSteps?: number;
}
