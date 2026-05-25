import type { Issue, IssueSource, MergeRequest, PrRef } from "./types";
import { run as runCli } from "./run";

const READ_RETRIES = 3;

const run = (args: string[], cwd?: string) => runCli("gh", args, { cwd });
const runRead = (args: string[], cwd?: string) =>
  runCli("gh", args, { cwd, retries: READ_RETRIES });

const ISSUE_JSON_FIELDS = "number,title,body,labels,state,url";
const PR_JSON_FIELDS =
  "number,title,body,author,headRefName,baseRefName,state,url,labels,isDraft";

const toIssue = (i: any): Issue => ({
  iid: Number(i.number),
  title: String(i.title || ""),
  description: i.body ? String(i.body) : "",
  labels: Array.isArray(i.labels)
    ? i.labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean)
    : [],
  state: String(i.state || "").toLowerCase(),
  web_url: i.url,
});

const toMr = (m: any): MergeRequest => ({
  iid: Number(m.number),
  title: String(m.title || ""),
  description: m.body ? String(m.body) : "",
  author: m.author?.login ? String(m.author.login) : undefined,
  source_branch: String(m.headRefName || ""),
  target_branch: String(m.baseRefName || ""),
  state: String(m.state || "").toLowerCase(),
  web_url: m.url,
  labels: Array.isArray(m.labels)
    ? m.labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean)
    : [],
  draft: Boolean(m.isDraft),
});

const stateFlag = (state?: "opened" | "closed" | "all"): string => {
  if (state === "closed") return "closed";
  if (state === "all") return "all";
  return "open";
};

export const githubSource: IssueSource = {
  provider: "github",
  cliName: "gh",

  list(repo, opts = {}) {
    const limit = Math.max(1, opts.limit ?? 50);
    const args = [
      "issue",
      "list",
      "-R",
      repo,
      "--state",
      stateFlag(opts.state),
      "--limit",
      String(limit),
      "--json",
      ISSUE_JSON_FIELDS,
    ];
    if (opts.label) args.push("--label", opts.label);
    const r = runRead(args);
    if (!r.ok) return [];
    try {
      const arr = JSON.parse(r.stdout);
      return arr.map(toIssue);
    } catch {
      return [];
    }
  },

  view(repo, iid) {
    const r = runRead(["issue", "view", String(iid), "-R", repo, "--json", ISSUE_JSON_FIELDS]);
    if (!r.ok) return null;
    try {
      return toIssue(JSON.parse(r.stdout));
    } catch {
      return null;
    }
  },

  comment(repo, iid, message) {
    const r = run(["issue", "comment", String(iid), "-R", repo, "-b", message]);
    return r.ok;
  },

  findPrBySourceBranch(repo, branch): PrRef | null {
    const r = runRead([
      "pr",
      "list",
      "-R",
      repo,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "url,state",
    ]);
    if (!r.ok) return null;
    try {
      const arr = JSON.parse(r.stdout);
      if (Array.isArray(arr) && arr.length > 0) {
        return { url: String(arr[0].url || "") };
      }
      return null;
    } catch {
      return null;
    }
  },

  createPr(repo, cwd, branch, title) {
    const r = run(
      ["pr", "create", "-R", repo, "--head", branch, "--title", title, "--fill"],
      cwd,
    );
    const url = (r.stdout.match(/https?:\/\/\S+/) || [])[0];
    return { url, stdout: r.stdout, stderr: r.stderr };
  },

  listMrs(repo, opts = {}) {
    const limit = Math.max(1, opts.limit ?? 50);
    const args = [
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      stateFlag(opts.state),
      "--limit",
      String(limit),
      "--json",
      PR_JSON_FIELDS,
    ];
    if (opts.label) args.push("--label", opts.label);
    const r = runRead(args);
    if (!r.ok) return [];
    try {
      const arr = JSON.parse(r.stdout);
      return arr.map(toMr);
    } catch {
      return [];
    }
  },

  viewMr(repo, iid) {
    const r = runRead(["pr", "view", String(iid), "-R", repo, "--json", PR_JSON_FIELDS]);
    if (!r.ok) return null;
    try {
      return toMr(JSON.parse(r.stdout));
    } catch {
      return null;
    }
  },

  getMrDiff(repo, iid) {
    const r = runRead(["pr", "diff", String(iid), "-R", repo]);
    return r.ok ? r.stdout : "";
  },

  commentMr(repo, iid, message) {
    const r = run(["pr", "comment", String(iid), "-R", repo, "-b", message]);
    return r.ok;
  },
};
