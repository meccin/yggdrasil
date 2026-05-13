import { runGit } from "../git";
import { detectDefaultBranch } from "../agent/worktree";

export type DiffLineKind =
  | "file-header"
  | "hunk"
  | "added"
  | "removed"
  | "context"
  | "meta"
  | "label"
  | "blank";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

// Classify a unified-diff line for coloring. Conservative — anything that
// doesn't match a well-known marker falls back to `context` so we never
// accidentally paint, say, an issue comment line as a code addition.
export const classifyDiffLine = (raw: string): DiffLineKind => {
  if (raw.startsWith("diff --git ")) return "file-header";
  if (raw.startsWith("@@")) return "hunk";
  if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("index ")) return "meta";
  if (raw.startsWith("+")) return "added";
  if (raw.startsWith("-")) return "removed";
  if (raw === "") return "blank";
  return "context";
};

// Build the full set of lines shown in the diff view: a per-section label
// followed by the raw git output lines. Each section gets a `label` kind so
// the renderer can style it distinctly.
export const buildDiffLines = (sections: Array<{ title: string; body: string }>): DiffLine[] => {
  const out: DiffLine[] = [];
  for (const s of sections) {
    out.push({ kind: "label", text: `── ${s.title} ──` });
    const lines = s.body.split("\n");
    for (const l of lines) {
      // Avoid trailing-empty noise from a single split() on a trailing newline.
      if (l === "" && lines[lines.length - 1] === l && lines.length === 1) continue;
      out.push({ kind: classifyDiffLine(l), text: l });
    }
    out.push({ kind: "blank", text: "" });
  }
  return out;
};

export interface DiffSummary {
  commits: number;
  filesChanged: number;
}

// Cheap one-pass scan: count `diff --git` blocks and `^commit ` lines from
// the unified diff and `git log` sections. Used in the header for at-a-glance
// stats without invoking git separately for `--shortstat`.
export const summarizeDiff = (
  diffBody: string,
  logOneLineBody: string,
): DiffSummary => {
  let filesChanged = 0;
  for (const l of diffBody.split("\n")) {
    if (l.startsWith("diff --git ")) filesChanged += 1;
  }
  const commits = logOneLineBody
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
  return { commits, filesChanged };
};

export interface FetchedDiff {
  lines: DiffLine[];
  summary: DiffSummary;
  base: string;
}

// Run the actual git commands inside the worktree and assemble a DiffLine
// array ready to render. Errors short-circuit each section so partial output
// (e.g. only `git status` works because the branch hasn't diverged yet) still
// reaches the UI.
export const fetchAgentDiff = (worktreePath: string): FetchedDiff => {
  const base = detectDefaultBranch(worktreePath);
  const baseRef = `origin/${base}`;

  const status = runGit(["status", "--short"], worktreePath);
  const log = runGit(
    ["log", `${baseRef}..HEAD`, "--oneline", "--no-decorate"],
    worktreePath,
  );
  const committed = runGit(["diff", `${baseRef}..HEAD`], worktreePath);
  const uncommitted = runGit(["diff"], worktreePath);

  const sections: Array<{ title: string; body: string }> = [];
  if (status.ok) sections.push({ title: "STATUS", body: status.stdout.trim() || "(clean)" });
  if (log.ok) sections.push({ title: `COMMITS (${baseRef}..HEAD)`, body: log.stdout.trim() || "(no commits)" });
  if (committed.ok) sections.push({ title: `DIFF (${baseRef}..HEAD)`, body: committed.stdout || "(empty)" });
  if (uncommitted.ok && uncommitted.stdout.trim().length > 0) {
    sections.push({ title: "DIFF (uncommitted)", body: uncommitted.stdout });
  }

  return {
    lines: buildDiffLines(sections),
    summary: summarizeDiff(committed.stdout, log.stdout),
    base,
  };
};
