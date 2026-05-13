import { spawnSync } from "node:child_process";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export const runGit = (args: string[], cwd?: string): GitResult => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
};

export interface PushResult {
  ok: boolean;
  branchExisted: boolean;
  stderr: string;
}

export const pushBranch = (cwd: string, branch: string): PushResult => {
  const first = runGit(["push", "-u", "origin", branch], cwd);
  if (first.ok) return { ok: true, branchExisted: false, stderr: "" };
  if (/rejected|already exists|non-fast-forward|set upstream/i.test(first.stderr)) {
    const second = runGit(["push", "origin", branch], cwd);
    return { ok: second.ok, branchExisted: true, stderr: second.stderr };
  }
  return { ok: false, branchExisted: false, stderr: first.stderr };
};

export const hasUncommittedChanges = (cwd: string): boolean => {
  const r = runGit(["status", "--porcelain"], cwd);
  return r.ok && r.stdout.trim().length > 0;
};

export const hasAnyCommits = (cwd: string, branch: string): boolean => {
  const r = runGit(["rev-list", "--count", `origin/HEAD..${branch}`], cwd);
  if (!r.ok) {
    const fallback = runGit(["log", "--oneline", "-1", branch], cwd);
    return fallback.ok && fallback.stdout.trim().length > 0;
  }
  return Number(r.stdout.trim()) > 0;
};
