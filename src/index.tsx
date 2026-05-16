import React from "react";
import { render } from "ink";
import { App } from "./ui/App";
import { hydrateState, startPersistLoop, stopPersistLoop, persistState } from "./store";
import { startPoller, stopPoller } from "./auto/poller";
import { killAllAgents } from "./agent/runner";
import { pruneOldestFiles } from "./rotation";
import { logsRoot } from "./paths";
import { enterAltScreen, leaveAltScreen } from "./altScreen";

export const runTui = async (): Promise<void> => {
  hydrateState();
  pruneOldestFiles(logsRoot(), { keep: 200, suffix: ".ndjson" });
  startPersistLoop();
  startPoller();

  enterAltScreen();

  const ink = render(<App />, {
    stdout: process.stdout,
    stdin: process.stdin,
    exitOnCtrlC: false,
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    stopPoller();
    stopPersistLoop();
    persistState();
    killAllAgents();
    leaveAltScreen();
  };

  process.on("exit", leaveAltScreen);
  process.on("uncaughtException", (err) => {
    leaveAltScreen();
    console.error(err);
    process.exit(1);
  });
  process.on("SIGINT", () => {
    cleanup();
    try {
      ink.unmount();
    } catch {}
    process.exit(0);
  });

  await ink.waitUntilExit();
  cleanup();
};
