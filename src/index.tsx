import React from "react";
import { render } from "ink";
import { App } from "./ui/App";
import { hydrateState, startPersistLoop, stopPersistLoop, persistState } from "./store";
import { startPoller, stopPoller } from "./auto/poller";
import { killAllAgents } from "./agent/runner";
import { pruneOldestFiles } from "./rotation";
import { logsRoot } from "./paths";

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[H";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

let altScreenActive = false;

const enterAltScreen = (): void => {
  if (altScreenActive) return;
  process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
  altScreenActive = true;
};

const leaveAltScreen = (): void => {
  if (!altScreenActive) return;
  process.stdout.write(SHOW_CURSOR + LEAVE_ALT_SCREEN);
  altScreenActive = false;
};

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
