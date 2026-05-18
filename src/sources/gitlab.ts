import type { Issue, IssueSource, PrRef } from "./types";
import { run as runCli } from "./run";

const READ_RETRIES = 3;

const run = (args: string[], cwd?: string) => runCli("glab", args, { cwd });
const runRead = (args: string[], cwd?: string) =>
  runCli("glab", args, { cwd, retries: READ_RETRIES });

const toIssue = (i: any): Issue => ({
  iid: Number(i.iid),
  title: String(i.title || ""),
  description: i.description ? String(i.description) : "",
  labels: Array.isArray(i.labels)
    ? i.labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean)
    : [],
  state: String(i.state || ""),
  web_url: i.web_url,
});

export const gitlabSource: IssueSource = {
  provider: "gitlab",
  cliName: "glab",

  list(repo, opts = {}) {
    // glab REST API caps `--per-page` at 100, so honor higher `limit` by
    // paginating with `--page N` and stopping at the first short/empty page.
    // `--closed` / `--all` toggle state — there is no `--state` flag.
    const target = Math.max(1, opts.limit ?? 50);
    const perPage = Math.min(100, target);
    const out: any[] = [];
    for (let page = 1; out.length < target; page++) {
      const args = [
        "issue",
        "list",
        "-R",
        repo,
        "-O",
        "json",
        "-P",
        String(perPage),
        "--page",
        String(page),
      ];
      if (opts.label) args.push("--label", opts.label);
      if (opts.state === "closed") args.push("--closed");
      else if (opts.state === "all") args.push("--all");
      const r = runRead(args);
      if (!r.ok) break;
      let arr: any[];
      try {
        arr = JSON.parse(r.stdout);
      } catch {
        break;
      }
      if (!Array.isArray(arr) || arr.length === 0) break;
      out.push(...arr);
      if (arr.length < perPage) break;
      if (page >= 50) break;
    }
    return out.slice(0, target).map(toIssue);
  },

  view(repo, iid) {
    // Note: glab is inconsistent — `issue view` and `mr list` take `-F json`,
    // but `issue list` takes `-O json`.
    const r = runRead(["issue", "view", String(iid), "-R", repo, "-F", "json"]);
    if (!r.ok) return null;
    try {
      return toIssue(JSON.parse(r.stdout));
    } catch {
      return null;
    }
  },

  comment(repo, iid, message) {
    const r = run(["issue", "note", String(iid), "-R", repo, "-m", message]);
    return r.ok;
  },

  findPrBySourceBranch(repo, branch): PrRef | null {
    const r = runRead(["mr", "list", "-R", repo, "--source-branch", branch, "-F", "json"]);
    if (!r.ok) return null;
    try {
      const arr = JSON.parse(r.stdout);
      if (Array.isArray(arr) && arr.length > 0) {
        return { url: String(arr[0].web_url || "") };
      }
      return null;
    } catch {
      return null;
    }
  },

  createPr(repo, cwd, branch, title) {
    const r = run(
      ["mr", "create", "-R", repo, "--source-branch", branch, "--title", title, "--fill", "--yes"],
      cwd,
    );
    const url = (r.stdout.match(/https?:\/\/\S+/) || [])[0];
    return { url, stdout: r.stdout, stderr: r.stderr };
  },
};
