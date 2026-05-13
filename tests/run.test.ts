import { describe, test, expect } from "bun:test";
import { isTransientError } from "../src/sources/run";

describe("isTransientError", () => {
  test("DNS failure", () => {
    expect(isTransientError("Could not resolve host: gitlab.example.com")).toBe(true);
    expect(isTransientError("getaddrinfo: Name or service not known")).toBe(true);
  });

  test("connection refused / reset", () => {
    expect(isTransientError("connect ECONNREFUSED 1.2.3.4")).toBe(true);
    expect(isTransientError("Connection reset by peer")).toBe(true);
  });

  test("server errors 5xx", () => {
    expect(isTransientError("got status 502")).toBe(true);
    expect(isTransientError("status 503 service unavailable")).toBe(true);
    expect(isTransientError("HTTP 504 gateway timeout")).toBe(true);
  });

  test("client errors are NOT transient", () => {
    expect(isTransientError("404 Not Found")).toBe(false);
    expect(isTransientError("401 Unauthorized")).toBe(false);
  });

  test("empty stderr is not transient", () => {
    expect(isTransientError("")).toBe(false);
  });
});
