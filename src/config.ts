import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { configFile, ensureUserDirs } from "./paths";
import type { GlobalConfig, RepoConfig, PermissionMode, FinalizeMode } from "./types";
import type { Provider } from "./sources/types";
import { detectRemote } from "./sources";
import { loadProfile, type Profile } from "./profile";
import { sweepOrphanWorktrees } from "./agent/worktree";

// Default tools a fresh-installed Yggdrasil will allow on every spawn unless
// the repo overrides it. Picked to cover the typical coding-agent flow
// (read/write/search/Bash for git+lint+test) without admitting WebFetch, Task
// delegation, or other higher-impact tools by default.
export const DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];

const DEFAULT_CONFIG: GlobalConfig = {
  permissionMode: "acceptEdits",
  maxConcurrent: 3,
  pollIntervalSec: 300,
  defaultMode: "review",
  allowedTools: [...DEFAULT_ALLOWED_TOOLS],
  disallowedTools: [],
  settingsPath: null,
  notifications: true,
  profile: null,
  maxIssuesPerRepo: 200,
  repos: [],
};

// Migrate older entries that stored remoteRepo without the host. Only fires
// when the detected slug *adds* a host prefix to the stored value — never
// shortens or replaces a manually-edited slug.
// Older repo entries stored display `name` as the full host-prefixed slug
// (e.g. "gitlab.example.com/group/proj") because repoNameFromPath returned
// the same value as remoteRepo. Display now drops the host — migrate existing
// entries when their first segment looks like a host.
const migrateRepoName = (repo: RepoConfig): RepoConfig => {
  const segments = repo.name.split("/");
  if (segments.length >= 3 && segments[0].includes(".")) {
    return { ...repo, name: segments.slice(1).join("/") };
  }
  return repo;
};

const migrateRepoSlug = (repo: RepoConfig): RepoConfig => {
  if (repo.provider !== "gitlab") return repo;
  if (!existsSync(repo.path)) return repo;
  const detected = detectRemote(repo.path);
  if (!detected || detected.provider !== "gitlab") return repo;
  if (detected.repo === repo.remoteRepo) return repo;
  // detected adds a host prefix relative to the stored slug
  if (detected.repo.endsWith("/" + repo.remoteRepo)) {
    return { ...repo, remoteRepo: detected.repo };
  }
  return repo;
};

export const loadConfig = (): GlobalConfig => {
  ensureUserDirs();
  if (!existsSync(configFile())) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = readFileSync(configFile(), "utf8");
    const parsed = JSON.parse(raw);
    const cfg = validateConfig(parsed);
    const migrated = {
      ...cfg,
      repos: cfg.repos.map(migrateRepoSlug).map(migrateRepoName),
    };
    if (JSON.stringify(migrated) !== JSON.stringify(cfg)) {
      saveConfig(migrated);
    }
    try {
      sweepOrphanWorktrees(migrated.repos);
    } catch (err) {
      console.error(`[yggdrasil] orphan worktree sweep failed: ${err}`);
    }
    return migrated;
  } catch (err) {
    console.error(`[yggdrasil] config corrupted, using defaults: ${err}`);
    return { ...DEFAULT_CONFIG };
  }
};

export const saveConfig = (cfg: GlobalConfig): void => {
  ensureUserDirs();
  writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
};

const validateConfig = (raw: any): GlobalConfig => {
  const cfg: GlobalConfig = { ...DEFAULT_CONFIG, ...raw };
  if (!Array.isArray(cfg.repos)) cfg.repos = [];
  cfg.pollIntervalSec = Math.max(60, Number(cfg.pollIntervalSec) || 300);
  cfg.maxConcurrent = Math.max(1, Math.min(10, Number(cfg.maxConcurrent) || 3));
  cfg.allowedTools = Array.isArray(cfg.allowedTools)
    ? cfg.allowedTools.map(String)
    : [...DEFAULT_ALLOWED_TOOLS];
  cfg.disallowedTools = Array.isArray(cfg.disallowedTools)
    ? cfg.disallowedTools.map(String)
    : [];
  cfg.settingsPath = cfg.settingsPath ? String(cfg.settingsPath) : null;
  cfg.notifications =
    typeof cfg.notifications === "boolean" ? cfg.notifications : true;
  cfg.profile = cfg.profile ? String(cfg.profile) : null;
  cfg.maxIssuesPerRepo = Math.max(
    50,
    Math.min(2000, Number(cfg.maxIssuesPerRepo) || 200),
  );
  cfg.repos = cfg.repos.map(normalizeRepo);
  return cfg;
};

const validProvider = (v: any): Provider => (v === "github" ? "github" : "gitlab");

// Back-compat: older configs used `glab` field; migrate to `remoteRepo` + provider gitlab.
const normalizeRepo = (r: any): RepoConfig => {
  const remoteRepo = r.remoteRepo || r.glab || "";
  const provider = validProvider(r.provider || (r.glab ? "gitlab" : "gitlab"));
  return {
    name: String(r.name),
    path: String(r.path),
    provider,
    remoteRepo: String(remoteRepo),
    autoSpawn: Boolean(r.autoSpawn),
    autoSpawnLabel: String(r.autoSpawnLabel || "agent-ready"),
    autoSpawnMrLabel: r.autoSpawnMrLabel ? String(r.autoSpawnMrLabel) : null,
    mrReviewInlineDefault: Boolean(r.mrReviewInlineDefault),
    permissionMode: r.permissionMode || null,
    defaultMode: r.defaultMode || null,
    claudeConfigDir: r.claudeConfigDir ? String(r.claudeConfigDir) : null,
    allowedTools: Array.isArray(r.allowedTools) ? r.allowedTools.map(String) : null,
    disallowedTools: Array.isArray(r.disallowedTools) ? r.disallowedTools.map(String) : null,
    settingsPath: r.settingsPath ? String(r.settingsPath) : null,
    profile: r.profile ? String(r.profile) : null,
  };
};

export const resolvePermissionMode = (
  cfg: GlobalConfig,
  repo: RepoConfig,
): PermissionMode => repo.permissionMode || cfg.permissionMode;

export const resolveMode = (
  cfg: GlobalConfig,
  repo: RepoConfig,
): FinalizeMode => repo.defaultMode || cfg.defaultMode;

export const resolveAllowedTools = (
  cfg: GlobalConfig,
  repo: RepoConfig,
): string[] => repo.allowedTools ?? cfg.allowedTools;

export const resolveDisallowedTools = (
  cfg: GlobalConfig,
  repo: RepoConfig,
): string[] => repo.disallowedTools ?? cfg.disallowedTools;

export const resolveSettingsPath = (
  cfg: GlobalConfig,
  repo: RepoConfig,
): string | null => repo.settingsPath ?? cfg.settingsPath;

// Repo-level profile name wins over global; either may be null. Returns the
// loaded Profile or null when no profile is configured or the file is missing.
// Throws when the referenced profile exists but fails validation — callers
// surface that as a user-visible error rather than silently falling back.
export const resolveProfile = (
  cfg: GlobalConfig,
  repo: RepoConfig,
): Profile | null => {
  const name = repo.profile ?? cfg.profile;
  if (!name) return null;
  return loadProfile(name);
};

export const resolveProfileName = (
  cfg: GlobalConfig,
  repo: RepoConfig,
): string | null => repo.profile ?? cfg.profile;

export const upsertRepo = (cfg: GlobalConfig, repo: RepoConfig): GlobalConfig => {
  const idx = cfg.repos.findIndex((r) => r.name === repo.name);
  const next = { ...cfg, repos: [...cfg.repos] };
  if (idx >= 0) next.repos[idx] = repo;
  else next.repos.push(repo);
  return next;
};

export const removeRepo = (cfg: GlobalConfig, name: string): GlobalConfig => ({
  ...cfg,
  repos: cfg.repos.filter((r) => r.name !== name),
});
