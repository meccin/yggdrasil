import { mkdirSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { runGit } from "../git";
import { worktreeFor, worktreeForMr, worktreesRoot } from "../paths";
import type { Provider } from "../sources/types";

export interface WorktreeRef {
  path: string;
  branch: string;
}

export const detectDefaultBranch = (repoPath: string): string => {
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
export const isValidWorktree = (path: string): boolean => {
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

// Add a read-only worktree pointing at the MR/PR head. The provider CLI
// (`gh pr checkout` / `glab mr checkout`) switches the HEAD of whatever
// working tree it runs in, so we MUST add an empty worktree first and run the
// checkout inside it — otherwise the user's main repo HEAD silently moves.
// gh: `--detach` keeps the worktree on a detached HEAD (gh 2.6+). glab: needs
// a local branch name; we use `mr-review-<iid>` and force-delete any stale
// one beforehand, then the worktree's HEAD ends up on that branch. The branch
// is local-only and cleaned up alongside the worktree.
export const addReadOnlyWorktreeForMr = (
  repoName: string,
  repoPath: string,
  provider: Provider,
  mrIid: number,
  remoteRepo: string,
): WorktreeRef => {
  const path = worktreeForMr(repoName, mrIid);
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path) && !isValidWorktree(path)) {
    runGit(["worktree", "prune"], repoPath);
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {}
  }

  const glabBranch = `mr-review-${mrIid}`;
  if (existsSync(path) && isValidWorktree(path)) {
    return { path, branch: provider === "gitlab" ? glabBranch : "" };
  }

  // Step 1: create an empty worktree pinned to origin/<default>. It will be
  // moved off this commit by the provider CLI below.
  const baseBranch = detectDefaultBranch(repoPath);
  runGit(["fetch", "origin", baseBranch], repoPath);
  const wt = runGit(
    ["worktree", "add", "--detach", path, `origin/${baseBranch}`],
    repoPath,
  );
  if (!wt.ok) {
    throw new Error(`worktree add failed: ${wt.stderr}`);
  }
  if (!isValidWorktree(path)) {
    throw new Error(`worktree created but .git pointer is missing at ${path}`);
  }

  // Step 2: provider checkout INSIDE the new worktree so only its HEAD moves.
  // Cleans the branch up before running glab so a stale `mr-review-<N>` from
  // a prior cleanup-failed run doesn't block checkout.
  const cli = provider === "github" ? "gh" : "glab";
  let checkoutArgs: string[];
  if (provider === "github") {
    checkoutArgs = ["pr", "checkout", String(mrIid), "-R", remoteRepo, "--detach"];
  } else {
    runGit(["branch", "-D", glabBranch], repoPath); // best-effort
    checkoutArgs = ["mr", "checkout", String(mrIid), "-R", remoteRepo, "-b", glabBranch];
  }
  const result = spawnSync(cli, checkoutArgs, { cwd: path, encoding: "utf8" });
  if (result.status !== 0) {
    runGit(["worktree", "remove", "--force", path], repoPath);
    const stderr = (result.stderr || "").trim();
    throw new Error(
      `${cli} ${checkoutArgs.slice(0, 2).join(" ")} failed for !${mrIid}: ${stderr || "unknown error"}`,
    );
  }

  return { path, branch: provider === "gitlab" ? glabBranch : "" };
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
  if (opts.deleteBranch && branch) {
    runGit(["branch", "-D", branch], repoPath);
  }
};

// Sweep worktrees that no current repo owns. Catches leftovers from
// `migrateRepoName` (host-prefixed slug → short slug) where the old worktree
// dir still holds a branch and blocks fresh spawns. For each known repo, asks
// git which worktrees it has registered, removes any whose slug-directory
// doesn't match any current repo name, drops the matching `agent/issue-N`
// branch, then rm -rf's leftover dirs under wt root.
export const sweepOrphanWorktrees = (
  repos: { name: string; path: string }[],
): void => {
  const wtRoot = worktreesRoot();
  if (!existsSync(wtRoot)) return;
  const slugify = (n: string) => n.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const knownSlugs = new Set(repos.map((r) => slugify(r.name)));

  for (const repo of repos) {
    if (!existsSync(repo.path)) continue;
    const r = runGit(["worktree", "list", "--porcelain"], repo.path);
    if (!r.ok) continue;
    const paths = r.stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim());
    for (const wtPath of paths) {
      if (!wtPath.startsWith(wtRoot + "/")) continue;
      const rel = wtPath.slice(wtRoot.length + 1);
      const slug = rel.split("/")[0];
      if (knownSlugs.has(slug)) continue;
      runGit(["worktree", "remove", "--force", wtPath], repo.path);
      const m = rel.match(/^[^/]+\/issue-(\d+)$/);
      if (m) runGit(["branch", "-D", `agent/issue-${m[1]}`], repo.path);
    }
    runGit(["worktree", "prune"], repo.path);
  }

  let topEntries: string[] = [];
  try {
    topEntries = readdirSync(wtRoot);
  } catch {
    return;
  }
  for (const slug of topEntries) {
    if (knownSlugs.has(slug)) continue;
    const dir = join(wtRoot, slug);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
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
