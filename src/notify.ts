import { spawn } from "node:child_process";

// Escape a string for safe embedding inside an AppleScript double-quoted
// literal: backslash and double-quote need a leading backslash; newlines
// become escaped \n so the `osascript -e` command stays a single line.
// Exposed for unit testing — the alternative is to spawn osascript with
// fuzzed input which we want to avoid.
export const escapeAppleScript = (s: string): string =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");

// Fire-and-forget desktop notification. macOS uses `osascript`, Linux uses
// `notify-send`. Any other platform is a silent no-op. Failures here never
// propagate — a missing notifier should not tear down the running TUI.
export const notify = (title: string, body: string): void => {
  try {
    if (process.platform === "darwin") {
      const safeTitle = escapeAppleScript(title);
      const safeBody = escapeAppleScript(body);
      const script = `display notification "${safeBody}" with title "${safeTitle}"`;
      const child = spawn("osascript", ["-e", script], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      child.on("error", () => {});
      return;
    }
    if (process.platform === "linux") {
      // --app-name lets GNOME/KDE notification centers group entries under
      // "Yggdrasil". Some lighter daemons (dunst, etc.) may ignore it; the
      // title still carries enough context regardless.
      const child = spawn(
        "notify-send",
        ["--app-name=Yggdrasil", title, body],
        { stdio: "ignore", detached: true },
      );
      child.unref();
      child.on("error", () => {});
      return;
    }
    // Windows or other platforms: silent no-op for now.
  } catch {
    // Swallow — notification failure must never crash the parent.
  }
};
