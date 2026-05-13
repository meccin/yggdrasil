import { describe, test, expect } from "bun:test";
import { parseRemoteUrl } from "../src/sources";

describe("parseRemoteUrl", () => {
  test("https github", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo.git")).toEqual({
      host: "github.com",
      path: "owner/repo",
    });
  });

  test("https self-hosted gitlab without .git", () => {
    expect(parseRemoteUrl("https://gitlab.example.com/team/proj")).toEqual({
      host: "gitlab.example.com",
      path: "team/proj",
    });
  });

  test("ssh-style git@host:path", () => {
    expect(parseRemoteUrl("git@gitlab.example.com:owner/repo.git")).toEqual({
      host: "gitlab.example.com",
      path: "owner/repo",
    });
  });

  test("ssh:// with port", () => {
    expect(parseRemoteUrl("ssh://git@gitlab.example.com:22/team/proj.git")).toEqual({
      host: "gitlab.example.com",
      path: "team/proj",
    });
  });

  test("host casing normalized to lowercase", () => {
    expect(parseRemoteUrl("https://GITHUB.com/owner/repo")!.host).toBe("github.com");
  });

  test("unrecognized URL returns null", () => {
    expect(parseRemoteUrl("nonsense")).toBeNull();
  });
});
