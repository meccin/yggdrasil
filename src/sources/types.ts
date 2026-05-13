export type Provider = "gitlab" | "github";

export interface Issue {
  iid: number;
  title: string;
  description?: string;
  labels: string[];
  state: string;
  web_url?: string;
}

export interface PrRef {
  url: string;
}

export interface IssueSource {
  readonly provider: Provider;
  readonly cliName: string;
  list(
    repo: string,
    opts?: { label?: string; state?: "opened" | "closed" | "all" },
  ): Issue[];
  view(repo: string, iid: number): Issue | null;
  comment(repo: string, iid: number, message: string): boolean;
  findPrBySourceBranch(repo: string, branch: string): PrRef | null;
  createPr(repo: string, cwd: string, branch: string, title: string): PrRef | null;
}
