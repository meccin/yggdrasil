import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, saveConfig, upsertRepo, removeRepo } from "./config";
import { detectRemote, repoNameFromPath } from "./sources";
import { ensureUserDirs, userDir, configFile } from "./paths";
import { aggregate, formatReport, readMetrics } from "./metrics";
import type { Provider, RepoConfig } from "./types";

const VERSION = "0.6.0";

const printHelp = (): void => {
  console.log(`Yggdrasil ${VERSION} — TUI multi-agent dashboard

Usage:
  ygg                                opens TUI (default)
  ygg repo add <path> [opts]         add repo (auto-detect provider+remote)
                                       --label NAME        autoSpawn label
                                       --provider gitlab|github   force provider
                                       --claude-dir PATH   custom CLAUDE_CONFIG_DIR
  ygg repo list                      list configured repos
  ygg repo set <name> [opts]         edit fields on an existing repo
                                       --claude-dir PATH|none
                                       --label NAME
                                       --permission-mode MODE|none
                                       --default-mode mr|review|dry|none
                                       --allow-tool TOOL        (repeatable; replaces allowlist)
                                       --disallow-tool TOOL     (repeatable; replaces denylist)
                                       --settings PATH|none     (claude settings JSON)
                                       --reset-tools            (clear repo override → inherit global)
  ygg repo rm <name>                 remove repo by name
  ygg metrics [opts]                 show usage metrics
                                       --repo NAME
                                       --since YYYY-MM-DD
                                       --until YYYY-MM-DD
                                       --json
  ygg doctor                         validate deps and config
  ygg --version                      print version
  ygg --help                         this help
`);
};

const hasBin = (name: string): boolean => {
  const r = spawnSync("which", [name], { encoding: "utf8" });
  return r.status === 0 && Boolean(r.stdout.trim());
};

// glab/gh return exit 1 when ANY configured host fails (e.g. default gitlab.com
// without a token), even though the user is properly logged in to a self-hosted
// instance. Parse stdout+stderr for "Logged in" to decide.
const authOk = (bin: string): boolean => {
  const r = spawnSync(bin, ["auth", "status"], { encoding: "utf8" });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  return /Logged in to/i.test(out);
};

const glabAuthOk = (): boolean => authOk("glab");
const ghAuthOk = (): boolean => authOk("gh");

const cmdDoctor = (): number => {
  ensureUserDirs();
  let ok = true;
  const check = (label: string, pass: boolean, hint?: string) => {
    console.log(`${pass ? "✓" : "✗"} ${label}${pass ? "" : hint ? "  → " + hint : ""}`);
    if (!pass) ok = false;
  };
  check("bin: claude", hasBin("claude"), "install Claude Code CLI");
  check("bin: git", hasBin("git"));
  check(`dir: ${userDir()}`, existsSync(userDir()));
  check(`config: ${configFile()}`, existsSync(configFile()));
  const cfg = loadConfig();
  console.log(`  repos: ${cfg.repos.length}`);
  console.log(`  maxConcurrent: ${cfg.maxConcurrent}`);

  const providers = new Set(cfg.repos.map((r) => r.provider));
  if (providers.has("gitlab") || cfg.repos.length === 0) {
    check("bin: glab", hasBin("glab"), "brew install glab");
    if (hasBin("glab")) check("glab auth", glabAuthOk(), "run `glab auth login`");
  }
  if (providers.has("github")) {
    check("bin: gh", hasBin("gh"), "brew install gh");
    if (hasBin("gh")) check("gh auth", ghAuthOk(), "run `gh auth login`");
  }

  for (const r of cfg.repos) {
    const exists = existsSync(r.path);
    check(`  repo ${r.name} [${r.provider}] (${r.path})`, exists, "path does not exist");
  }

  // Validate any `settingsPath` reference (global + per-repo).
  const settingsPaths: Array<{ source: string; path: string }> = [];
  if (cfg.settingsPath) settingsPaths.push({ source: "global", path: cfg.settingsPath });
  for (const r of cfg.repos) {
    if (r.settingsPath) settingsPaths.push({ source: r.name, path: r.settingsPath });
  }
  for (const s of settingsPaths) {
    if (!existsSync(s.path)) {
      check(`settings (${s.source}): ${s.path}`, false, "file does not exist");
      continue;
    }
    let parses = true;
    try {
      JSON.parse(readFileSync(s.path, "utf8"));
    } catch {
      parses = false;
    }
    check(`settings (${s.source}): ${s.path}`, parses, "file is not valid JSON");
  }

  return ok ? 0 : 1;
};

const cmdRepoAdd = (rawArgs: string[]): number => {
  const args = [...rawArgs];
  let label = "agent-ready";
  let forcedProvider: Provider | undefined;

  const popFlag = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx >= 0) {
      const v = args[idx + 1];
      args.splice(idx, 2);
      return v;
    }
    return undefined;
  };

  const labelArg = popFlag("--label");
  if (labelArg) label = labelArg;

  const providerArg = popFlag("--provider");
  if (providerArg) {
    if (providerArg !== "gitlab" && providerArg !== "github") {
      console.error(`invalid provider: ${providerArg} (expected gitlab|github)`);
      return 1;
    }
    forcedProvider = providerArg;
  }

  const claudeDirArg = popFlag("--claude-dir");
  const claudeConfigDir = claudeDirArg ? resolve(claudeDirArg) : null;
  if (claudeConfigDir && !existsSync(claudeConfigDir)) {
    console.error(`--claude-dir path does not exist: ${claudeConfigDir}`);
    return 1;
  }

  const path = args[0] && resolve(args[0]);
  if (!path) {
    console.error("usage: ygg repo add <path> [--label NAME] [--provider gitlab|github] [--claude-dir PATH]");
    return 1;
  }
  if (!existsSync(path)) {
    console.error(`path does not exist: ${path}`);
    return 1;
  }

  const detected = detectRemote(path);
  if (!detected && !forcedProvider) {
    console.error(`could not detect remote provider for ${path}. Configure 'origin' or pass --provider.`);
    return 1;
  }

  const provider: Provider = forcedProvider || detected!.provider;
  const remoteRepo = detected?.repo || "";
  if (!remoteRepo) {
    console.error("could not extract repo slug from remote URL");
    return 1;
  }

  const cfg = loadConfig();
  const name = repoNameFromPath(path);
  const existing = cfg.repos.find((r) => r.name === name);
  const repo: RepoConfig = {
    name,
    path,
    provider,
    remoteRepo,
    autoSpawn: existing?.autoSpawn ?? false,
    autoSpawnLabel: labelArg ? label : existing?.autoSpawnLabel ?? label,
    permissionMode: existing?.permissionMode ?? null,
    defaultMode: existing?.defaultMode ?? null,
    claudeConfigDir: claudeDirArg ? claudeConfigDir : existing?.claudeConfigDir ?? null,
    allowedTools: existing?.allowedTools ?? null,
    disallowedTools: existing?.disallowedTools ?? null,
    settingsPath: existing?.settingsPath ?? null,
  };
  saveConfig(upsertRepo(cfg, repo));
  const claudeNote = repo.claudeConfigDir ? ` · claude:${repo.claudeConfigDir}` : "";
  console.log(`✓ repo ${existing ? "updated" : "added"}: ${name} [${provider}] (${remoteRepo})${claudeNote}`);
  return 0;
};

const cmdRepoList = (): number => {
  const cfg = loadConfig();
  if (cfg.repos.length === 0) {
    console.log("(no repos configured)");
    return 0;
  }
  for (const r of cfg.repos) {
    const allowSrc = r.allowedTools === null ? " (global)" : "";
    const denySrc = r.disallowedTools === null ? " (global)" : "";
    const settingsSrc = r.settingsPath === null ? " (global)" : "";
    const allowList = (r.allowedTools ?? cfg.allowedTools).join(", ") || "(none)";
    const denyList = (r.disallowedTools ?? cfg.disallowedTools).join(", ") || "(none)";
    const settingsVal = (r.settingsPath ?? cfg.settingsPath) || "(none)";
    console.log(`- ${r.name}`);
    console.log(`    path:     ${r.path}`);
    console.log(`    provider: ${r.provider}`);
    console.log(`    remote:   ${r.remoteRepo}`);
    console.log(`    auto:     ${r.autoSpawn ? "on" : "off"} · label: ${r.autoSpawnLabel}`);
    console.log(`    perm:     ${r.permissionMode || "(global)"}`);
    console.log(`    mode:     ${r.defaultMode || "(global)"}`);
    console.log(`    claude:   ${r.claudeConfigDir || "(default ~/.claude)"}`);
    console.log(`    allow:    ${allowList}${allowSrc}`);
    console.log(`    deny:     ${denyList}${denySrc}`);
    console.log(`    settings: ${settingsVal}${settingsSrc}`);
  }
  return 0;
};

const cmdRepoSet = (rawArgs: string[]): number => {
  const args = [...rawArgs];
  const pop = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx >= 0) {
      const v = args[idx + 1];
      args.splice(idx, 2);
      return v;
    }
    return undefined;
  };
  // Repeatable string flag — pulls out every occurrence in declaration order.
  // Used for `--allow-tool` / `--disallow-tool` where the full list replaces
  // the previous repo override.
  const popAll = (flag: string): string[] => {
    const out: string[] = [];
    while (true) {
      const idx = args.indexOf(flag);
      if (idx < 0) break;
      const v = args[idx + 1];
      args.splice(idx, 2);
      if (v !== undefined) out.push(v);
    }
    return out;
  };
  const popBool = (flag: string): boolean => {
    const idx = args.indexOf(flag);
    if (idx < 0) return false;
    args.splice(idx, 1);
    return true;
  };
  const name = args.shift();
  if (!name) {
    console.error(
      "usage: ygg repo set <name> [--claude-dir PATH|none] [--label NAME] [--permission-mode MODE] [--default-mode mr|review|dry]",
    );
    return 1;
  }
  const cfg = loadConfig();
  const repo = cfg.repos.find((r) => r.name === name);
  if (!repo) {
    console.error(`repo not found: ${name}`);
    return 1;
  }
  const next = { ...repo };

  const claudeDirArg = pop("--claude-dir");
  if (claudeDirArg !== undefined) {
    if (claudeDirArg === "none" || claudeDirArg === "") {
      next.claudeConfigDir = null;
    } else {
      const resolved = resolve(claudeDirArg);
      if (!existsSync(resolved)) {
        console.error(`--claude-dir path does not exist: ${resolved}`);
        return 1;
      }
      next.claudeConfigDir = resolved;
    }
  }

  const labelArg = pop("--label");
  if (labelArg !== undefined) next.autoSpawnLabel = labelArg;

  const permArg = pop("--permission-mode");
  if (permArg !== undefined) {
    next.permissionMode = permArg === "none" ? null : (permArg as RepoConfig["permissionMode"]);
  }

  const modeArg = pop("--default-mode");
  if (modeArg !== undefined) {
    if (modeArg === "none") next.defaultMode = null;
    else if (modeArg === "mr" || modeArg === "review" || modeArg === "dry") {
      next.defaultMode = modeArg;
    } else {
      console.error(`invalid --default-mode: ${modeArg}`);
      return 1;
    }
  }

  const allowTools = popAll("--allow-tool");
  const disallowTools = popAll("--disallow-tool");
  const resetTools = popBool("--reset-tools");
  if (resetTools) {
    next.allowedTools = null;
    next.disallowedTools = null;
  }
  if (allowTools.length > 0) next.allowedTools = allowTools;
  if (disallowTools.length > 0) next.disallowedTools = disallowTools;

  const settingsArg = pop("--settings");
  if (settingsArg !== undefined) {
    if (settingsArg === "none" || settingsArg === "") {
      next.settingsPath = null;
    } else {
      const resolved = resolve(settingsArg);
      if (!existsSync(resolved)) {
        console.error(`--settings path does not exist: ${resolved}`);
        return 1;
      }
      next.settingsPath = resolved;
    }
  }

  saveConfig(upsertRepo(cfg, next));
  console.log(`✓ repo updated: ${name}`);
  return 0;
};

const cmdRepoRm = (args: string[]): number => {
  const name = args[0];
  if (!name) {
    console.error("usage: ygg repo rm <name>");
    return 1;
  }
  const cfg = loadConfig();
  if (!cfg.repos.find((r) => r.name === name)) {
    console.error(`repo not found: ${name}`);
    return 1;
  }
  saveConfig(removeRepo(cfg, name));
  console.log(`✓ removed: ${name}`);
  return 0;
};

const parseDate = (s: string): number | undefined => {
  const ts = Date.parse(s);
  return Number.isNaN(ts) ? undefined : ts;
};

const cmdMetrics = (rawArgs: string[]): number => {
  const args = [...rawArgs];
  const pop = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx >= 0) {
      const v = args[idx + 1];
      args.splice(idx, 2);
      return v;
    }
    return undefined;
  };
  const asJson = args.includes("--json");
  if (asJson) args.splice(args.indexOf("--json"), 1);
  const repo = pop("--repo");
  const sinceStr = pop("--since");
  const untilStr = pop("--until");
  const sinceMs = sinceStr ? parseDate(sinceStr) : undefined;
  const untilMs = untilStr ? parseDate(untilStr) : undefined;

  const events = readMetrics({ repo, sinceMs, untilMs });
  const agg = aggregate(events);

  if (asJson) {
    console.log(JSON.stringify(agg, null, 2));
    return 0;
  }

  const desc: string[] = [];
  if (repo) desc.push(`repo ${repo}`);
  if (sinceStr) desc.push(`since ${sinceStr}`);
  if (untilStr) desc.push(`until ${untilStr}`);
  console.log(formatReport(agg, desc.join(" · ")));
  return 0;
};

export const main = async (argv: string[]): Promise<number> => {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "tui") {
    const { runTui } = await import("./index");
    await runTui();
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return 0;
  }
  if (cmd === "doctor") return cmdDoctor();
  if (cmd === "metrics") return cmdMetrics(rest);
  if (cmd === "repo") {
    const sub = rest[0];
    const subArgs = rest.slice(1);
    if (sub === "add") return cmdRepoAdd(subArgs);
    if (sub === "list" || sub === "ls") return cmdRepoList();
    if (sub === "rm" || sub === "remove") return cmdRepoRm(subArgs);
    if (sub === "set") return cmdRepoSet(subArgs);
    console.error("usage: ygg repo <add|list|rm|set>");
    return 1;
  }
  console.error(`unknown command: ${cmd}`);
  printHelp();
  return 1;
};
