import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { configFile, ensureUserDirs } from "./paths";
import type { GlobalConfig, RepoConfig, PermissionMode, FinalizeMode } from "./types";
import type { Provider } from "./sources/types";
import { detectRemote } from "./sources";

const DEFAULT_CONFIG: GlobalConfig = {
  permissionMode: "acceptEdits",
  maxConcurrent: 3,
  pollIntervalSec: 300,
  defaultMode: "review",
  repos: [],
};

// Migrate older entries that stored remoteRepo without the host. Only fires
// when the detected slug *adds* a host prefix to the stored value — never
// shortens or replaces a manually-edited slug.
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
    const migrated = { ...cfg, repos: cfg.repos.map(migrateRepoSlug) };
    if (JSON.stringify(migrated) !== JSON.stringify(cfg)) {
      saveConfig(migrated);
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
    permissionMode: r.permissionMode || null,
    defaultMode: r.defaultMode || null,
    claudeConfigDir: r.claudeConfigDir ? String(r.claudeConfigDir) : null,
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
