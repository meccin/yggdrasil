import { spawnSync } from "node:child_process";

export const hasBin = (name: string): boolean => {
  const r = spawnSync("which", [name], { encoding: "utf8" });
  return r.status === 0 && Boolean(r.stdout.trim());
};

// glab/gh return exit 1 when ANY configured host fails (e.g. default
// gitlab.com without a token), even when the user is properly logged into a
// self-hosted instance. Parse stdout+stderr for "Logged in" instead of the
// exit code.
export const authOk = (bin: string): boolean => {
  const r = spawnSync(bin, ["auth", "status"], { encoding: "utf8" });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  return /Logged in to/i.test(out);
};

export const glabAuthOk = (): boolean => authOk("glab");
export const ghAuthOk = (): boolean => authOk("gh");

export interface CheckResult {
  name: string;
  ok: boolean;
  level: "fatal" | "warn" | "info";
  hint?: string;
}

// Structured doctor checks for the setup wizard. Provider CLIs are surfaced
// as warnings here (not fatal) because the wizard does not yet know which
// provider the user picks. `claude` and `git` are non-negotiable, so they
// are fatal. The wizard halts if any fatal check fails or if both provider
// CLIs are missing.
export const runStartupChecks = (): CheckResult[] => {
  const checks: CheckResult[] = [];

  const claude = hasBin("claude");
  checks.push({
    name: "Claude Code CLI (`claude`)",
    ok: claude,
    level: "fatal",
    hint: claude ? undefined : "install from https://claude.com/claude-code",
  });

  const git = hasBin("git");
  checks.push({
    name: "git",
    ok: git,
    level: "fatal",
    hint: git ? undefined : "install git (e.g. xcode-select --install / apt install git)",
  });

  const glab = hasBin("glab");
  if (glab) {
    const glabAuthed = glabAuthOk();
    checks.push({
      name: "glab (GitLab CLI) + auth",
      ok: glabAuthed,
      level: "warn",
      hint: glabAuthed ? undefined : "run `glab auth login`",
    });
  } else {
    checks.push({
      name: "glab (GitLab CLI)",
      ok: false,
      level: "info",
      hint: "brew install glab  (only needed for GitLab repos)",
    });
  }

  const gh = hasBin("gh");
  if (gh) {
    const ghAuthed = ghAuthOk();
    checks.push({
      name: "gh (GitHub CLI) + auth",
      ok: ghAuthed,
      level: "warn",
      hint: ghAuthed ? undefined : "run `gh auth login`",
    });
  } else {
    checks.push({
      name: "gh (GitHub CLI)",
      ok: false,
      level: "info",
      hint: "brew install gh  (only needed for GitHub repos)",
    });
  }

  return checks;
};

// True when no `fatal`-level check has failed. Missing/unauthed provider
// CLIs surface as warnings so the wizard can still proceed — the user may
// know they'll auth before the first spawn, or pick a provider whose CLI
// is already present. Final hard validation happens implicitly when an
// agent runs.
export const startupBlocking = (checks: CheckResult[]): { ok: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  for (const c of checks) {
    if (c.level === "fatal" && !c.ok) {
      reasons.push(`${c.name}${c.hint ? ` — ${c.hint}` : ""}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
};

// Soft signal: returns true when no provider CLI is present *and* authed.
// Surfaced as a yellow warning on Welcome — not a block.
export const noAuthedProvider = (checks: CheckResult[]): boolean => {
  return !checks.some(
    (c) =>
      c.ok &&
      (c.name.startsWith("glab (GitLab CLI) + auth") ||
        c.name.startsWith("gh (GitHub CLI) + auth")),
  );
};
