import { mkdirSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGit } from "../git";
import { worktreeFor } from "../paths";

export interface WorktreeRef {
  path: string;
  branch: string;
}

const detectDefaultBranch = (repoPath: string): string => {
  const head = runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoPath);
  if (head.ok) {
    const m = head.stdout.trim().match(/^origin\/(.+)$/);
    if (m) return m[1];
  }
  for (const candidate of ["main", "master", "develop"]) {
    const r = runGit(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], repoPath);
    if (r.ok) return candidate;
  }
  return "main";
};

// A valid worktree directory contains a `.git` file (a regular file, NOT a
// directory) whose contents point back at the main repo's worktrees registry.
const isValidWorktree = (path: string): boolean => {
  if (!existsSync(path)) return false;
  const gitPath = join(path, ".git");
  if (!existsSync(gitPath)) return false;
  try {
    const st = statSync(gitPath);
    // Worktrees have a regular file .git (gitfile pointer). The main repo
    // checkout has a directory .git. Either way, presence means git can use it.
    return st.isFile() || st.isDirectory();
  } catch {
    return false;
  }
};

export const addWorktree = (
  repoName: string,
  repoPath: string,
  issueId: number,
): WorktreeRef => {
  const path = worktreeFor(repoName, issueId);
  const branch = `agent/issue-${issueId}`;
  mkdirSync(dirname(path), { recursive: true });

  // If something exists at the target path but it's not a real worktree,
  // clean it up (and prune any stale worktree registration) so we rebuild
  // from a clean slate. A previous failed run or external rm can leave
  // empty/half-broken dirs that would otherwise be silently reused.
  if (existsSync(path) && !isValidWorktree(path)) {
    runGit(["worktree", "prune"], repoPath);
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {}
  }

  if (existsSync(path) && isValidWorktree(path)) {
    return { path, branch };
  }

  const baseBranch = detectDefaultBranch(repoPath);
  runGit(["fetch", "origin", baseBranch], repoPath);

  const branchExists = runGit(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    repoPath,
  ).ok;
  const args = branchExists
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", path, "-b", branch, `origin/${baseBranch}`];

  const r = runGit(args, repoPath);
  if (!r.ok) {
    const fallback = runGit(["worktree", "add", path, "-b", branch], repoPath);
    if (!fallback.ok) {
      throw new Error(`worktree add failed: ${r.stderr || fallback.stderr}`);
    }
  }

  if (!isValidWorktree(path)) {
    throw new Error(`worktree created but .git pointer is missing at ${path}`);
  }

  return { path, branch };
};

export const removeWorktree = (
  repoPath: string,
  wtPath: string,
  branch: string,
  opts: { deleteBranch: boolean } = { deleteBranch: true },
): void => {
  runGit(["worktree", "remove", "--force", wtPath], repoPath);
  if (existsSync(wtPath)) {
    try {
      rmSync(wtPath, { recursive: true, force: true });
    } catch {}
  }
  if (opts.deleteBranch) {
    runGit(["branch", "-D", branch], repoPath);
  }
};

export const listWorktrees = (repoPath: string): string[] => {
  const r = runGit(["worktree", "list", "--porcelain"], repoPath);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
};
