import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  noAuthedProvider,
  runStartupChecks,
  startupBlocking,
  type CheckResult,
} from "../../doctor";
import { loadConfig, saveConfig, upsertRepo } from "../../config";
import type { RepoConfig } from "../../types";
import { Welcome } from "./steps/Welcome";
import { RepoPath } from "./steps/RepoPath";
import { ProviderStep } from "./steps/Provider";
import { PresetStep } from "./steps/Preset";
import { Settings } from "./steps/Settings";
import { Finish } from "./steps/Finish";
import {
  advancePreset,
  advanceProvider,
  advanceRepoPath,
  advanceSettings,
  advanceWelcome,
  initialState,
  stepIndex,
  toRepoConfig,
  TOTAL_STEPS,
  type WizardState,
} from "./state";

export type WizardReason = "completed" | "cancelled" | "blocked";

interface Props {
  cwd: string;
  onDone: (result: {
    repo: RepoConfig | null;
    launchTui: boolean;
    reason: WizardReason;
  }) => void;
}

// Header rendered on every step: title + step indicator. The fixed-width
// indicator keeps the chrome stable across step transitions so the user's
// eye doesn't bounce.
const Header: React.FC<{ step: WizardState["step"] }> = ({ step }) => {
  const idx = stepIndex(step);
  const showCounter = step !== "finish";
  return (
    <Box
      borderStyle="double"
      borderColor="magenta"
      paddingX={1}
      justifyContent="space-between"
    >
      <Text bold color="magenta">
        Yggdrasil setup
      </Text>
      {showCounter && (
        <Text dimColor>
          step {idx}/{TOTAL_STEPS}
        </Text>
      )}
    </Box>
  );
};

export const Wizard: React.FC<Props> = ({ cwd, onDone }) => {
  const { exit } = useApp();
  const [state, setState] = useState<WizardState>(() => initialState(cwd));
  const [pathDraft, setPathDraft] = useState(cwd);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [savedRepo, setSavedRepo] = useState<RepoConfig | null>(null);

  // Compute startup checks once when the wizard mounts. Filesystem +
  // subprocess calls are not cheap; redoing them per render would lag.
  const checks: CheckResult[] = useMemo(() => runStartupChecks(), []);
  const blocked = useMemo(() => startupBlocking(checks), [checks]);
  const providerWarning = useMemo(() => noAuthedProvider(checks), [checks]);

  // Cap height so the wizard never overflows the terminal — matches the
  // pattern used by the main App.
  const { stdout } = useStdout();
  const [termRows, setTermRows] = useState<number>(stdout?.rows ?? 40);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setTermRows(stdout.rows || 40);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const finalizeAndLaunch = () => {
    onDone({ repo: savedRepo, launchTui: true, reason: "completed" });
    exit();
  };

  const exitWizard = (
    repo: RepoConfig | null,
    launchTui: boolean,
    reason: WizardReason,
  ) => {
    onDone({ repo, launchTui, reason });
    exit();
  };

  useInput((input, key) => {
    if (key.ctrl && (input === "c" || input === "C")) {
      exitWizard(null, false, "cancelled");
      return;
    }

    if (showCancelConfirm) {
      if (input === "y" || input === "Y") {
        exitWizard(null, false, "cancelled");
        return;
      }
      if (input === "n" || input === "N" || key.escape) {
        setShowCancelConfirm(false);
        return;
      }
      return;
    }

    // Finish screen: enter → launch TUI, q/esc → exit without TUI.
    if (state.step === "finish") {
      if (key.return) {
        finalizeAndLaunch();
        return;
      }
      if (input === "q" || key.escape) {
        onDone({ repo: savedRepo, launchTui: false, reason: "completed" });
        exit();
        return;
      }
      return;
    }

    if (key.escape) {
      // No work yet on welcome — skip the discard-progress confirm. Also
      // exit fast with the right reason so the caller can return a useful
      // exit code (e.g. non-zero when blocked by missing deps).
      if (state.step === "welcome") {
        exitWizard(null, false, blocked.ok ? "cancelled" : "blocked");
        return;
      }
      setShowCancelConfirm(true);
      return;
    }

    if (state.step === "welcome") {
      if (key.return && blocked.ok) setState(advanceWelcome(state));
      return;
    }
  });

  const handleRepoSubmit = (value: string) => {
    setPathDraft(value);
    setState((s) => advanceRepoPath(s, value));
  };

  const handleProviderSelect = (provider: WizardState["provider"]) => {
    setState((s) => advanceProvider(s, provider));
  };

  const handlePresetSelect = (id: WizardState["preset"]) => {
    setState((s) => advancePreset(s, id));
  };

  // Save synchronously inside the input handler. Doing it here (rather than
  // in a useEffect on state.step) guarantees that by the time the Finish
  // screen renders, the config is already on disk — so an immediate
  // `enter` from the user can never launch the TUI before the repo has
  // been persisted.
  const handleSettingsSubmit = (label: string, mode: WizardState["mode"]) => {
    const nextState = advanceSettings(state, label, mode);
    try {
      const repo = toRepoConfig(nextState);
      const cfg = loadConfig();
      saveConfig(upsertRepo(cfg, repo));
      setSavedRepo(repo);
      setState(nextState);
    } catch (err) {
      console.error("[yggdrasil] wizard save failed:", err);
      exitWizard(null, false, "cancelled");
    }
  };

  const body = (() => {
    switch (state.step) {
      case "welcome":
        return (
          <Welcome
            checks={checks}
            blocked={blocked}
            providerWarning={providerWarning}
          />
        );
      case "repoPath":
        return (
          <RepoPath
            value={pathDraft}
            onChange={setPathDraft}
            onSubmit={handleRepoSubmit}
            error={state.error}
          />
        );
      case "provider":
        if (!state.detected) return <Text color="red">internal error: no detected remote</Text>;
        return <ProviderStep detected={state.detected} onSelect={handleProviderSelect} />;
      case "preset":
        return <PresetStep initial={state.preset} onSelect={handlePresetSelect} />;
      case "settings":
        return (
          <Settings
            path={state.path}
            provider={state.provider}
            preset={state.preset}
            initialLabel={state.label}
            initialMode={state.mode}
            onSubmit={handleSettingsSubmit}
          />
        );
      case "finish":
        if (!savedRepo) return <Text color="yellow">saving…</Text>;
        return <Finish repoName={savedRepo.name} />;
    }
  })();

  return (
    <Box flexDirection="column" height={termRows} overflow="hidden">
      <Header step={state.step} />
      <Box paddingX={1} paddingY={1} flexDirection="column" flexGrow={1}>
        {body}
      </Box>
      {showCancelConfirm && (
        <Box borderStyle="double" borderColor="red" paddingX={1}>
          <Text color="red" bold>
            Cancel setup and discard progress? (y/n)
          </Text>
        </Box>
      )}
    </Box>
  );
};
