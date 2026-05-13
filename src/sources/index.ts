import { runGit } from "../git";
import { gitlabSource } from "./gitlab";
import { githubSource } from "./github";
import type { IssueSource, Provider } from "./types";

export type { Issue, IssueSource, PrRef, Provider } from "./types";
export { gitlabSource, githubSource };

export const getSource = (provider: Provider): IssueSource =>
  provider === "github" ? githubSource : gitlabSource;

export interface RemoteInfo {
  provider: Provider;
  repo: string;
}

// Parse a git remote URL into { host, path }.
// Handles https://host/path(.git), http://host/path(.git), git@host:path(.git),
// and ssh://user@host[:port]/path(.git).
export const parseRemoteUrl = (url: string): { host: string; path: string } | null => {
  const stripGit = (s: string) => s.replace(/\.git$/, "");

  // ssh://user@host[:port]/path
  let m = url.match(/^ssh:\/\/(?:[^@]+@)?([^:/]+)(?::\d+)?\/(.+)$/i);
  if (m) return { host: m[1].toLowerCase(), path: stripGit(m[2]) };

  // git@host:path
  m = url.match(/^[^@\s]+@([^:]+):(.+)$/);
  if (m) return { host: m[1].toLowerCase(), path: stripGit(m[2]) };

  // https?://host/path
  m = url.match(/^https?:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/i);
  if (m) return { host: m[1].toLowerCase(), path: stripGit(m[2]) };

  return null;
};

export const detectRemote = (repoPath: string): RemoteInfo | null => {
  const r = runGit(["remote", "get-url", "origin"], repoPath);
  if (!r.ok) return null;
  const parsed = parseRemoteUrl(r.stdout.trim());
  if (!parsed) return null;

  if (parsed.host === "github.com" || parsed.host.endsWith(".github.com")) {
    return { provider: "github", repo: parsed.path };
  }

  // GitLab (default gitlab.com OR self-hosted). For self-hosted, include the
  // host in the slug so glab can resolve the API endpoint without ambiguity.
  const isDefault = parsed.host === "gitlab.com";
  const slug = isDefault ? parsed.path : `${parsed.host}/${parsed.path}`;
  return { provider: "gitlab", repo: slug };
};

export const repoNameFromPath = (repoPath: string): string => {
  const info = detectRemote(repoPath);
  if (info) return info.repo;
  const parts = repoPath.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || parts[parts.length - 1] || repoPath;
};
