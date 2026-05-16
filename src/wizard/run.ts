import React from "react";
import { render } from "ink";
import { Wizard, type WizardReason } from "../ui/wizard/Wizard";
import type { RepoConfig } from "../types";
import { enterAltScreen, leaveAltScreen } from "../altScreen";

export interface WizardResult {
  repo: RepoConfig | null;
  launchTui: boolean;
  reason: WizardReason;
}

// Render the wizard in alt-screen, resolve when it exits. Mirrors the
// lifecycle in src/index.tsx so quitting the wizard leaves the user's
// terminal in a clean state.
export const runWizard = async (cwd = process.cwd()): Promise<WizardResult> => {
  enterAltScreen();
  let result: WizardResult = { repo: null, launchTui: false, reason: "cancelled" };

  const ink = render(
    React.createElement(Wizard, {
      cwd,
      onDone: (res) => {
        result = res;
      },
    }),
    {
      stdout: process.stdout,
      stdin: process.stdin,
      exitOnCtrlC: false,
    },
  );

  process.on("uncaughtException", (err) => {
    leaveAltScreen();
    console.error(err);
    process.exit(1);
  });

  try {
    await ink.waitUntilExit();
  } finally {
    // Keep alt-screen active across the handoff to runTui so the user
    // doesn't see a flash of the parent terminal between wizard close and
    // TUI mount. Caller leaves it.
    if (!result.launchTui) leaveAltScreen();
  }
  return result;
};
