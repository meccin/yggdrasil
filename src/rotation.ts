import { existsSync, renameSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface RotateOpts {
  // Trigger rotation when the file exceeds this many bytes. Default 5MB.
  maxBytes?: number;
  // How many archived files to keep (file.1 … file.N). Default 5.
  keep?: number;
}

// Rotate a single growing file in place. The active file is renamed to .1, the
// existing .1 to .2, and so on; rolloff beyond `keep` is deleted. The active
// path is left absent so the next write starts a fresh file. Safe to call when
// the file does not yet exist — it's a no-op in that case.
export const rotateFileIfNeeded = (filePath: string, opts: RotateOpts = {}): boolean => {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = Math.max(1, opts.keep ?? 5);
  if (!existsSync(filePath)) return false;
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;
  // Drop the oldest first so the slot opens up.
  const oldest = `${filePath}.${keep}`;
  if (existsSync(oldest)) {
    try {
      unlinkSync(oldest);
    } catch {}
  }
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${filePath}.${i}`;
    const to = `${filePath}.${i + 1}`;
    if (existsSync(from)) {
      try {
        renameSync(from, to);
      } catch {}
    }
  }
  try {
    renameSync(filePath, `${filePath}.1`);
  } catch {
    return false;
  }
  return true;
};

export interface PruneOpts {
  // Maximum number of files to keep in the directory. Default 200.
  keep?: number;
  // Only consider files matching this suffix (e.g. ".ndjson").
  suffix?: string;
}

// Prune oldest files in a directory by mtime so the total count stays within
// `keep`. Used to bound the per-agent log directory which never compacts on
// its own (each agent writes its own file).
export const pruneOldestFiles = (dirPath: string, opts: PruneOpts = {}): number => {
  const keep = Math.max(1, opts.keep ?? 200);
  const suffix = opts.suffix;
  if (!existsSync(dirPath)) return 0;
  let entries: { path: string; mtimeMs: number }[];
  try {
    entries = readdirSync(dirPath)
      .filter((name) => (suffix ? name.endsWith(suffix) : true))
      .map((name) => {
        const p = join(dirPath, name);
        try {
          return { path: p, mtimeMs: statSync(p).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { path: string; mtimeMs: number } => x !== null);
  } catch {
    return 0;
  }
  if (entries.length <= keep) return 0;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const toDelete = entries.slice(0, entries.length - keep);
  let removed = 0;
  for (const e of toDelete) {
    try {
      unlinkSync(e.path);
      removed += 1;
    } catch {}
  }
  return removed;
};
