import { spawn } from "node:child_process";

// Fire-and-forget process launcher used by openUrl/openPath/openInEditor below.
// Mirrors notify.ts: detached + stdio ignore + unref so the child outlives the
// TUI step and never bubbles errors up into Ink's raw-mode loop.
const launch = (cmd: string, args: string[]): boolean => {
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
    child.on("error", () => {});
    return true;
  } catch {
    return false;
  }
};

// Platform-default URL/path opener. macOS `open` accepts both URLs and paths,
// Linux `xdg-open` likewise, Windows `start` via cmd. Falls through to no-op
// on unknown platforms — failure is silent by design.
const systemOpen = (target: string): boolean => {
  if (process.platform === "darwin") return launch("open", [target]);
  if (process.platform === "linux") return launch("xdg-open", [target]);
  if (process.platform === "win32") return launch("cmd", ["/c", "start", "", target]);
  return false;
};

export const openUrl = (url: string): boolean => systemOpen(url);

export const openPath = (path: string): boolean => systemOpen(path);

// Editor resolution chain: $VISUAL → $EDITOR → system default (Finder /
// file manager). Terminal editors set via $EDITOR will fight for the TTY
// when spawned from inside Ink — users who want a GUI editor should set
// VISUAL=code (or cursor, subl, etc).
export const openInEditor = (path: string): boolean => {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (editor && editor.trim()) {
    // Allow `code --new-window` style env values by splitting on whitespace.
    const parts = editor.trim().split(/\s+/);
    const [bin, ...rest] = parts;
    if (bin && launch(bin, [...rest, path])) return true;
  }
  return systemOpen(path);
};
