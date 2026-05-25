import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { runGit } from "../../git";
import { detectRemote, repoNameFromPath, type RemoteInfo } from "../../sources";
import type { FinalizeMode, Provider, RepoConfig } from "../../types";
import { getPreset, type PresetId } from "./presets";

export type WizardStep =
  | "welcome"
  | "repoPath"
  | "provider"
  | "preset"
  | "settings"
  | "finish";

export const STEP_ORDER: WizardStep[] = [
  "welcome",
  "repoPath",
  "provider",
  "preset",
  "settings",
  "finish",
];

// Step indicator counts every step except "finish" (which is the completion
// screen, not a numbered step). Keeps "5/5" displayed on the last input
// screen instead of "6/6".
export const stepIndex = (step: WizardStep): number => {
  const numbered: WizardStep[] = ["welcome", "repoPath", "provider", "preset", "settings"];
  const i = numbered.indexOf(step);
  return i < 0 ? numbered.length : i + 1;
};

export const TOTAL_STEPS = 5;

export interface WizardState {
  step: WizardStep;
  path: string;
  detected: RemoteInfo | null;
  provider: Provider;
  preset: PresetId;
  label: string;
  mode: FinalizeMode;
  error: string | null;
}

export const initialState = (cwd: string): WizardState => ({
  step: "welcome",
  path: cwd,
  detected: null,
  provider: "gitlab",
  preset: "balanced",
  label: "agent-ready",
  mode: "review",
  error: null,
});

export interface PathValidation {
  ok: boolean;
  resolved: string;
  detected: RemoteInfo | null;
  error?: string;
}

// Resolve + validate a repo path. Used by the RepoPath step before
// transitioning forward. The function is pure relative to the filesystem
// (calls existsSync / git / detectRemote) so tests stub these by handing
// in real fixture paths.
export const validateRepoPath = (raw: string): PathValidation => {
  if (!raw || !raw.trim()) {
    return { ok: false, resolved: "", detected: null, error: "path cannot be empty" };
  }
  const resolved = resolve(raw.trim());
  if (!existsSync(resolved)) {
    return { ok: false, resolved, detected: null, error: "path does not exist" };
  }
  let isDir = false;
  try {
    isDir = statSync(resolved).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return { ok: false, resolved, detected: null, error: "path is not a directory" };
  }
  const inside = runGit(["rev-parse", "--is-inside-work-tree"], resolved);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return {
      ok: false,
      resolved,
      detected: null,
      error: "path is not a git working tree (try `git init` + `git remote add origin …`)",
    };
  }
  const detected = detectRemote(resolved);
  if (!detected) {
    return {
      ok: false,
      resolved,
      detected: null,
      error:
        "could not parse `git remote get-url origin` — configure an origin remote first",
    };
  }
  return { ok: true, resolved, detected };
};

// Synthesize the RepoConfig that will be persisted. Caller passes the
// finished WizardState; this stays pure so unit tests can assert the exact
// produced shape.
export const toRepoConfig = (state: WizardState): RepoConfig => {
  if (!state.detected) {
    throw new Error("toRepoConfig called without a detected remote");
  }
  const preset = getPreset(state.preset);
  return {
    name: repoNameFromPath(state.path),
    path: state.path,
    provider: state.provider,
    remoteRepo: state.detected.repo,
    autoSpawn: false,
    autoSpawnLabel: state.label.trim() || "agent-ready",
    autoSpawnMrLabel: null,
    mrReviewInlineDefault: false,
    permissionMode: preset.permissionMode,
    defaultMode: state.mode,
    claudeConfigDir: null,
    allowedTools: [...preset.allowedTools],
    disallowedTools: null,
    settingsPath: null,
    profile: null,
  };
};

// Step transitions. Forward-only; `cancel` returns null to indicate the
// caller should unmount the wizard. Each transition validates its inputs
// and stamps `error` on the returned state without advancing on failure.
export const advanceWelcome = (state: WizardState): WizardState => ({
  ...state,
  step: "repoPath",
  error: null,
});

export const advanceRepoPath = (state: WizardState, rawPath: string): WizardState => {
  const v = validateRepoPath(rawPath);
  if (!v.ok) {
    return { ...state, path: rawPath, error: v.error || "invalid path" };
  }
  return {
    ...state,
    step: "provider",
    path: v.resolved,
    detected: v.detected,
    provider: v.detected!.provider,
    error: null,
  };
};

export const advanceProvider = (state: WizardState, provider: Provider): WizardState => ({
  ...state,
  provider,
  step: "preset",
  error: null,
});

export const advancePreset = (state: WizardState, preset: PresetId): WizardState => ({
  ...state,
  preset,
  step: "settings",
  error: null,
});

export const advanceSettings = (
  state: WizardState,
  label: string,
  mode: FinalizeMode,
): WizardState => ({
  ...state,
  label: label.trim() || "agent-ready",
  mode,
  step: "finish",
  error: null,
});

// Move the wizard backward; only available on internal navigation paths
// (currently unused — kept here so callers can wire ←/b without rewriting
// the state machine).
export const previousStep = (state: WizardState): WizardState => {
  const idx = STEP_ORDER.indexOf(state.step);
  if (idx <= 0) return state;
  return { ...state, step: STEP_ORDER[idx - 1], error: null };
};
