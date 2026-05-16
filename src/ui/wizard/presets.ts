import type { PermissionMode } from "../../types";
import { DEFAULT_ALLOWED_TOOLS } from "../../config";

export type PresetId = "safe" | "balanced" | "yolo";

export interface PresetDescriptor {
  id: PresetId;
  label: string;
  blurb: string;
  permissionMode: PermissionMode;
  allowedTools: string[];
  warning?: string;
}

// `balanced` and `yolo` track DEFAULT_ALLOWED_TOOLS so a future tweak to the
// default surface propagates automatically. `safe` deliberately diverges
// (narrower Bash pattern), so it spells out its allowlist by hand.
export const PRESETS: PresetDescriptor[] = [
  {
    id: "safe",
    label: "safe",
    blurb: "auto-deny outside allowlist · git-only Bash",
    permissionMode: "dontAsk",
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash(git *)"],
  },
  {
    id: "balanced",
    label: "balanced (recommended)",
    blurb: "accept edits · standard Bash · default tool set",
    permissionMode: "acceptEdits",
    allowedTools: [...DEFAULT_ALLOWED_TOOLS],
  },
  {
    id: "yolo",
    label: "yolo",
    blurb: "bypass all gates · worktree is your only boundary",
    permissionMode: "bypassPermissions",
    allowedTools: [...DEFAULT_ALLOWED_TOOLS],
    warning:
      "bypassPermissions removes every approval gate — worktree isolation is the only blast-radius boundary. Use only for fully-isolated experimentation.",
  },
];

export const getPreset = (id: PresetId): PresetDescriptor => {
  const found = PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`unknown preset: ${id}`);
  return found;
};
