import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { profileFile, profilesDir, ensureUserDirs } from "./paths";
import type { PermissionMode } from "./types";

export interface ProfileStep {
  // Short display name shown in logs and the TUI ("plan", "implement", ...).
  name: string;
  // Slash-command literal — e.g. "/harness:plan". The prompt sent to claude
  // is `{command} {args interpolado}`. Empty args is allowed.
  command: string;
  args: string;
  // Optional per-step overrides; cascade is step -> repo -> global.
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface Profile {
  name: string;
  steps: ProfileStep[];
}

// Max length (in bytes-ish) for any single interpolated value. Issue bodies
// from GitLab/GitHub can be huge (tables, screenshots inlined as base64);
// argv on macOS is ~256KB total so we cap per-field defensively.
const MAX_VAR_LEN = 50_000;

const truncVar = (s: string): string =>
  s.length <= MAX_VAR_LEN ? s : s.slice(0, MAX_VAR_LEN) + "\n…[truncated]";

// Plain `{{dot.path}}` substitution. Unknown keys collapse to empty string so
// a profile referring to `{{repo.foo}}` doesn't surface as literal mustache
// text in the prompt. Values are coerced via String().
export const interpolate = (template: string, vars: Record<string, unknown>): string =>
  template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const parts = key.split(".");
    let cur: any = vars;
    for (const p of parts) {
      if (cur == null) return "";
      cur = cur[p];
    }
    if (cur == null) return "";
    return truncVar(String(cur));
  });

export const validateProfile = (raw: any): Profile => {
  if (!raw || typeof raw !== "object") {
    throw new Error("profile: not an object");
  }
  const name = String(raw.name || "").trim();
  if (!name) throw new Error("profile: `name` is required");
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error("profile: `steps` must be a non-empty array");
  }
  const steps: ProfileStep[] = raw.steps.map((s: any, i: number) => {
    if (!s || typeof s !== "object") {
      throw new Error(`profile: step[${i}] is not an object`);
    }
    const command = String(s.command || "").trim();
    if (!command) {
      throw new Error(`profile: step[${i}] (${s.name || "?"}) missing \`command\``);
    }
    const step: ProfileStep = {
      name: String(s.name || `step${i + 1}`),
      command,
      args: typeof s.args === "string" ? s.args : "",
    };
    if (s.permissionMode) step.permissionMode = s.permissionMode as PermissionMode;
    if (Array.isArray(s.allowedTools)) step.allowedTools = s.allowedTools.map(String);
    if (Array.isArray(s.disallowedTools)) step.disallowedTools = s.disallowedTools.map(String);
    return step;
  });
  return { name, steps };
};

export const loadProfile = (name: string): Profile | null => {
  const path = profileFile(name);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return validateProfile(JSON.parse(raw));
  } catch (err) {
    throw new Error(`profile "${name}": ${(err as Error).message}`);
  }
};

export const listProfiles = (): string[] => {
  ensureUserDirs();
  if (!existsSync(profilesDir())) return [];
  return readdirSync(profilesDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
};

export const saveProfile = (p: Profile): void => {
  ensureUserDirs();
  validateProfile(p);
  writeFileSync(profileFile(p.name), JSON.stringify(p, null, 2));
};

export const deleteProfile = (name: string): boolean => {
  const path = profileFile(name);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
};

// Built-in scaffolds for `ygg profile init <name> --template <kind>`. The
// trailing `args` of the last step nudges the agent not to push and to leave
// the work committed — without it, user-authored prompts skip the guards
// that `buildPrompt` injects for classic single-shot agents.
export const scaffoldHarness = (name: string): Profile => ({
  name,
  steps: [
    {
      name: "plan",
      command: "/harness-plan",
      args: "Issue #{{issue.id}}: {{issue.title}}\n\n{{issue.body}}",
      permissionMode: "plan",
    },
    {
      name: "implement",
      command: "/harness-implement",
      args: "Implement the generated plan for issue #{{issue.id}}.",
      permissionMode: "acceptEdits",
    },
    {
      name: "evaluate",
      command: "/harness-evaluate",
      args:
        "Run sensors and review the implementation for issue #{{issue.id}}. " +
        "Ensure everything is committed at the end. DO NOT push — the supervisor handles that.",
    },
  ],
});

// OpenSpec slash-commands live under the `/opsx:` namespace. The shipped
// scaffold uses the `core` profile commands (propose + apply) which work
// out of the box. The optional `verify` step requires OpenSpec's expanded
// workflow (`openspec update` in the project) — leave it in and edit if you
// don't have that enabled.
export const scaffoldOpenspec = (name: string): Profile => ({
  name,
  steps: [
    {
      name: "propose",
      command: "/opsx:propose",
      args: "Issue #{{issue.id}}: {{issue.title}}\n\n{{issue.body}}",
    },
    {
      name: "apply",
      command: "/opsx:apply",
      args:
        "Apply the proposed change for issue #{{issue.id}}. " +
        "Ensure everything is committed at the end. DO NOT push — the supervisor handles that.",
      permissionMode: "acceptEdits",
    },
    {
      name: "verify",
      command: "/opsx:verify",
      args:
        "Validate the implementation matches the change artifacts for issue #{{issue.id}}. " +
        "Requires OpenSpec expanded workflow (`openspec update`).",
    },
  ],
});
