import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadConfig,
  saveConfig,
  upsertRepo,
  removeRepo,
  resolveAllowedTools,
  resolvePermissionMode,
} from "./config";
import { detectRemote, repoNameFromPath } from "./sources";
import { ensureUserDirs, userDir, configFile, profileFile, profilesDir } from "./paths";
import { aggregate, formatReport, readMetrics } from "./metrics";
import type { Provider, RepoConfig } from "./types";
import {
  deleteProfile,
  listProfiles,
  loadProfile,
  saveProfile,
  scaffoldHarness,
  scaffoldOpenspec,
} from "./profile";
import { hasBin, glabAuthOk, ghAuthOk } from "./doctor";

const VERSION = "1.3.0";

const printHelp = (): void => {
  console.log(`Yggdrasil ${VERSION} — TUI multi-agent dashboard

Usage:
  ygg                                opens TUI (default; prompts setup wizard when no repos)
  ygg init                           interactive setup wizard (first-run friendly)
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
                                       --profile NAME|none|reset (pipeline profile)
                                       --reset-tools            (clear repo override → inherit global)
  ygg repo rm <name>                 remove repo by name
  ygg config show                    print global defaults
  ygg config set [opts]              edit global defaults
                                       --poll-interval N        seconds (>= 60)
                                       --max-concurrent N       1..10
                                       --permission-mode MODE
                                       --default-mode mr|review|dry
                                       --notifications on|off
                                       --profile NAME|none      (default pipeline)
  ygg profile list                   list available profiles in ~/.yggdrasil/profiles
  ygg profile show <name>            print a profile's parsed contents
  ygg profile init <name> [opts]     scaffold a profile file
                                       --template harness|openspec|blank
  ygg profile rm <name>              delete a profile file
  ygg profile path <name>            print the on-disk path (use with $EDITOR)
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

const cmdDoctor = (): number => {
  ensureUserDirs();
  let ok = true;
  const check = (label: string, pass: boolean, hint?: string) => {
    console.log(`${pass ? "✓" : "✗"} ${label}${pass ? "" : hint ? "  → " + hint : ""}`);
    if (!pass) ok = false;
  };
  // Warnings don't fail the doctor — they're informational. Exit code stays
  // driven by `check()`.
  const warn = (label: string, hint?: string) => {
    console.log(`⚠ ${label}${hint ? "  → " + hint : ""}`);
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

  // Surface the most permissive-by-construction combo: bypassPermissions with
  // nothing on the allowlist. Worktree is the only blast-radius boundary at
  // that point. Doesn't fail the doctor — informational.
  for (const r of cfg.repos) {
    const perm = resolvePermissionMode(cfg, r);
    const allow = resolveAllowedTools(cfg, r);
    if (perm === "bypassPermissions" && allow.length === 0) {
      warn(
        `  repo ${r.name}: bypassPermissions + empty allowlist`,
        "agents run unrestricted; add --allow-tool or switch to --permission-mode dontAsk",
      );
    }
  }

  // Validate every referenced profile (global + per-repo). Missing file or
  // bad JSON fails doctor; parse errors quote the validator message.
  const profileRefs: Array<{ source: string; name: string }> = [];
  if (cfg.profile) profileRefs.push({ source: "global", name: cfg.profile });
  for (const r of cfg.repos) {
    if (r.profile) profileRefs.push({ source: r.name, name: r.profile });
  }
  for (const ref of profileRefs) {
    const path = profileFile(ref.name);
    if (!existsSync(path)) {
      check(`profile (${ref.source}): ${ref.name}`, false, `not found at ${path}`);
      continue;
    }
    let parsed = true;
    let parseErr = "";
    try {
      loadProfile(ref.name);
    } catch (err) {
      parsed = false;
      parseErr = (err as Error).message;
    }
    check(`profile (${ref.source}): ${ref.name}`, parsed, parseErr);
  }

  return ok ? 0 : 1;
};

const cmdProfileList = (): number => {
  ensureUserDirs();
  const names = listProfiles();
  if (names.length === 0) {
    console.log(`(no profiles in ${profilesDir()})`);
    console.log("hint: ygg profile init <name> --template harness");
    return 0;
  }
  const cfg = loadConfig();
  for (const name of names) {
    const refs: string[] = [];
    if (cfg.profile === name) refs.push("global");
    for (const r of cfg.repos) if (r.profile === name) refs.push(r.name);
    const tag = refs.length ? `  · used by: ${refs.join(", ")}` : "";
    console.log(`- ${name}${tag}`);
  }
  return 0;
};

const cmdProfileShow = (args: string[]): number => {
  const name = args[0];
  if (!name) {
    console.error("usage: ygg profile show <name>");
    return 1;
  }
  let profile;
  try {
    profile = loadProfile(name);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  if (!profile) {
    console.error(`profile not found: ${name} (expected ${profileFile(name)})`);
    return 1;
  }
  console.log(`profile: ${profile.name}  (${profileFile(name)})`);
  profile.steps.forEach((s, i) => {
    console.log(`  [${i + 1}/${profile!.steps.length}] ${s.name} → ${s.command}`);
    if (s.permissionMode) console.log(`        permissionMode: ${s.permissionMode}`);
    if (s.allowedTools) console.log(`        allow: ${s.allowedTools.join(", ") || "(none)"}`);
    if (s.disallowedTools) console.log(`        deny:  ${s.disallowedTools.join(", ") || "(none)"}`);
    if (s.args) {
      const preview = s.args.length > 200 ? s.args.slice(0, 200) + "…" : s.args;
      console.log(`        args: ${preview.replace(/\n/g, "\\n")}`);
    }
  });
  return 0;
};

const cmdProfileInit = (rawArgs: string[]): number => {
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
  const template = pop("--template") || "harness";
  const name = args[0];
  if (!name) {
    console.error("usage: ygg profile init <name> [--template harness|openspec|blank]");
    return 1;
  }
  ensureUserDirs();
  if (existsSync(profileFile(name))) {
    console.error(`profile already exists: ${profileFile(name)}`);
    return 1;
  }
  let profile;
  if (template === "harness") profile = scaffoldHarness(name);
  else if (template === "openspec") profile = scaffoldOpenspec(name);
  else if (template === "blank") {
    profile = {
      name,
      steps: [
        {
          name: "step1",
          command: "/your-slash-command",
          args: "Context for issue #{{issue.id}}: {{issue.title}}\n\n{{issue.body}}",
        },
      ],
    };
  } else {
    console.error(`invalid --template: ${template} (expected harness|openspec|blank)`);
    return 1;
  }
  saveProfile(profile);
  console.log(`✓ profile created: ${profileFile(name)}`);
  console.log("edit with: $EDITOR " + profileFile(name));
  console.log(`use with: ygg config set --profile ${name}    (or ygg repo set <repo> --profile ${name})`);
  return 0;
};

const cmdProfileRm = (args: string[]): number => {
  const name = args[0];
  if (!name) {
    console.error("usage: ygg profile rm <name>");
    return 1;
  }
  const cfg = loadConfig();
  const refs: string[] = [];
  if (cfg.profile === name) refs.push("global");
  for (const r of cfg.repos) if (r.profile === name) refs.push(r.name);
  if (refs.length > 0) {
    console.error(`profile ${name} is referenced by: ${refs.join(", ")}`);
    console.error("clear those references first (e.g. `ygg config set --profile none`)");
    return 1;
  }
  if (!deleteProfile(name)) {
    console.error(`profile not found: ${name}`);
    return 1;
  }
  console.log(`✓ profile removed: ${name}`);
  return 0;
};

const cmdProfilePath = (args: string[]): number => {
  const name = args[0];
  if (!name) {
    console.error("usage: ygg profile path <name>");
    return 1;
  }
  console.log(profileFile(name));
  return 0;
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
    profile: existing?.profile ?? null,
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
    const profileSrc = r.profile === null ? " (global)" : "";
    const profileVal = (r.profile ?? cfg.profile) || "(none)";
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
    console.log(`    profile:  ${profileVal}${profileSrc}`);
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

  const profileArg = pop("--profile");
  if (profileArg !== undefined) {
    if (profileArg === "none" || profileArg === "reset" || profileArg === "") {
      next.profile = null;
    } else {
      if (!existsSync(profileFile(profileArg))) {
        console.error(
          `--profile not found: ${profileArg} (expected ${profileFile(profileArg)})`,
        );
        return 1;
      }
      next.profile = profileArg;
    }
  }

  saveConfig(upsertRepo(cfg, next));
  console.log(`✓ repo updated: ${name}`);
  return 0;
};

const cmdConfigShow = (): number => {
  const cfg = loadConfig();
  console.log("Global defaults:");
  console.log(`  permissionMode:   ${cfg.permissionMode}`);
  console.log(`  defaultMode:      ${cfg.defaultMode}`);
  console.log(`  maxConcurrent:    ${cfg.maxConcurrent}`);
  console.log(`  pollIntervalSec:  ${cfg.pollIntervalSec}`);
  console.log(`  allowedTools:     ${cfg.allowedTools.join(", ") || "(none)"}`);
  console.log(`  disallowedTools:  ${cfg.disallowedTools.join(", ") || "(none)"}`);
  console.log(`  settingsPath:     ${cfg.settingsPath || "(none)"}`);
  console.log(`  notifications:    ${cfg.notifications ? "on" : "off"}`);
  console.log(`  profile:          ${cfg.profile || "(none)"}`);
  console.log(`  repos:            ${cfg.repos.length}`);
  return 0;
};

const cmdConfigSet = (rawArgs: string[]): number => {
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

  if (args.length === 0) {
    console.error(
      "usage: ygg config set [--poll-interval N] [--max-concurrent N] [--permission-mode MODE] [--default-mode mr|review|dry]",
    );
    return 1;
  }

  const cfg = loadConfig();
  const next = { ...cfg };
  const changes: string[] = [];

  const pollArg = pop("--poll-interval");
  if (pollArg !== undefined) {
    const n = Number(pollArg);
    if (!Number.isFinite(n) || n < 60) {
      console.error(`invalid --poll-interval: ${pollArg} (must be >= 60)`);
      return 1;
    }
    next.pollIntervalSec = Math.floor(n);
    changes.push(`pollIntervalSec=${next.pollIntervalSec}`);
  }

  const concArg = pop("--max-concurrent");
  if (concArg !== undefined) {
    const n = Number(concArg);
    if (!Number.isFinite(n) || n < 1 || n > 10) {
      console.error(`invalid --max-concurrent: ${concArg} (must be 1..10)`);
      return 1;
    }
    next.maxConcurrent = Math.floor(n);
    changes.push(`maxConcurrent=${next.maxConcurrent}`);
  }

  const permArg = pop("--permission-mode");
  if (permArg !== undefined) {
    const valid = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];
    if (!valid.includes(permArg)) {
      console.error(`invalid --permission-mode: ${permArg}`);
      return 1;
    }
    next.permissionMode = permArg as typeof next.permissionMode;
    changes.push(`permissionMode=${permArg}`);
  }

  const modeArg = pop("--default-mode");
  if (modeArg !== undefined) {
    if (modeArg !== "mr" && modeArg !== "review" && modeArg !== "dry") {
      console.error(`invalid --default-mode: ${modeArg}`);
      return 1;
    }
    next.defaultMode = modeArg;
    changes.push(`defaultMode=${modeArg}`);
  }

  const notifArg = pop("--notifications");
  if (notifArg !== undefined) {
    const v = notifArg.toLowerCase();
    if (v === "on" || v === "true") next.notifications = true;
    else if (v === "off" || v === "false") next.notifications = false;
    else {
      console.error(`invalid --notifications: ${notifArg} (use on|off)`);
      return 1;
    }
    changes.push(`notifications=${next.notifications ? "on" : "off"}`);
  }

  const profileArg = pop("--profile");
  if (profileArg !== undefined) {
    if (profileArg === "none" || profileArg === "") {
      next.profile = null;
      changes.push(`profile=(none)`);
    } else {
      if (!existsSync(profileFile(profileArg))) {
        console.error(
          `--profile not found: ${profileArg} (expected ${profileFile(profileArg)})`,
        );
        return 1;
      }
      next.profile = profileArg;
      changes.push(`profile=${profileArg}`);
    }
  }

  if (changes.length === 0) {
    console.error("no recognized flags passed; nothing changed");
    return 1;
  }

  saveConfig(next);
  console.log(`✓ config updated: ${changes.join(", ")}`);
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

// Inline y/N confirm rendered before the TUI launches when the user has no
// repos configured. Resolves true when the user accepts and the wizard
// completed (or false on decline / cancel). Kept tiny on purpose — bigger
// onboarding lives in `ygg init`.
const maybePromptInit = async (): Promise<{ accepted: boolean }> => {
  // Lazy-load Ink + React so non-TUI commands (metrics, doctor, repo …)
  // never pay the dependency-graph cost.
  const React = (await import("react")).default;
  const { render, Box, Text, useApp, useInput } = await import("ink");

  return new Promise((resolveOuter) => {
    let answered = false;
    const Prompt: React.FC = () => {
      const { exit } = useApp();
      useInput((input, key) => {
        if (key.escape || input === "n" || input === "N") {
          answered = true;
          resolveOuter({ accepted: false });
          exit();
          return;
        }
        if (key.return || input === "y" || input === "Y") {
          answered = true;
          resolveOuter({ accepted: true });
          exit();
          return;
        }
      });
      return React.createElement(
        Box,
        { flexDirection: "column", paddingX: 1, borderStyle: "round", borderColor: "magenta" },
        React.createElement(
          Text,
          { color: "magenta", bold: true },
          "No repos configured.",
        ),
        React.createElement(
          Text,
          null,
          "Run the setup wizard to add one? ",
          React.createElement(Text, { color: "cyan" }, "(Y/n)"),
        ),
      );
    };
    const ink = render(React.createElement(Prompt));
    ink.waitUntilExit().then(() => {
      if (!answered) resolveOuter({ accepted: false });
    });
  });
};

const cmdInit = async (): Promise<number> => {
  const { runWizard } = await import("./wizard/run");
  const result = await runWizard();
  if (result.launchTui) {
    const { runTui } = await import("./index");
    await runTui();
    return 0;
  }
  // Exit non-zero when the wizard halted because the environment is not
  // ready — matches `ygg doctor`'s exit semantics so scripts can detect it.
  return result.reason === "blocked" ? 1 : 0;
};

export const main = async (argv: string[]): Promise<number> => {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "tui") {
    const cfg = loadConfig();
    if (cfg.repos.length === 0) {
      const { accepted } = await maybePromptInit();
      if (accepted) {
        const { runWizard } = await import("./wizard/run");
        const result = await runWizard();
        if (!result.launchTui) return 0;
      }
    }
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
  if (cmd === "init") return cmdInit();
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
  if (cmd === "config") {
    const sub = rest[0];
    const subArgs = rest.slice(1);
    if (sub === "show" || sub === "ls" || sub === undefined) return cmdConfigShow();
    if (sub === "set") return cmdConfigSet(subArgs);
    console.error("usage: ygg config <show|set>");
    return 1;
  }
  if (cmd === "profile") {
    const sub = rest[0];
    const subArgs = rest.slice(1);
    if (sub === "list" || sub === "ls" || sub === undefined) return cmdProfileList();
    if (sub === "show") return cmdProfileShow(subArgs);
    if (sub === "init") return cmdProfileInit(subArgs);
    if (sub === "rm" || sub === "remove") return cmdProfileRm(subArgs);
    if (sub === "path") return cmdProfilePath(subArgs);
    console.error("usage: ygg profile <list|show|init|rm|path>");
    return 1;
  }
  console.error(`unknown command: ${cmd}`);
  printHelp();
  return 1;
};
