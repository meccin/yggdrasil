import { describe, test, expect } from "bun:test";
import {
  interpolate,
  scaffoldHarness,
  scaffoldOpenspec,
  validateProfile,
} from "../src/profile";

describe("interpolate", () => {
  test("substitutes flat keys", () => {
    expect(interpolate("a {{x}} b", { x: "Y" })).toBe("a Y b");
  });

  test("substitutes dot-path keys", () => {
    expect(
      interpolate("#{{issue.id}} {{issue.title}}", {
        issue: { id: 42, title: "fix bug" },
      }),
    ).toBe("#42 fix bug");
  });

  test("missing keys collapse to empty string", () => {
    expect(interpolate("[{{nope}}]", {})).toBe("[]");
    expect(interpolate("[{{a.b.c}}]", { a: { b: null } })).toBe("[]");
  });

  test("tolerates whitespace inside braces", () => {
    expect(interpolate("{{ x }}", { x: "ok" })).toBe("ok");
  });

  test("coerces non-string values to string", () => {
    expect(interpolate("{{n}}", { n: 7 })).toBe("7");
    expect(interpolate("{{b}}", { b: true })).toBe("true");
  });

  test("truncates oversized values defensively", () => {
    const big = "x".repeat(60_000);
    const out = interpolate("{{v}}", { v: big });
    expect(out.length).toBeLessThan(big.length);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  test("leaves literal non-mustache text untouched", () => {
    expect(interpolate("plain text { not a brace }", {})).toBe(
      "plain text { not a brace }",
    );
  });
});

describe("validateProfile", () => {
  test("accepts a minimal valid profile", () => {
    const p = validateProfile({
      name: "min",
      steps: [{ name: "s1", command: "/cmd", args: "" }],
    });
    expect(p.name).toBe("min");
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]!.command).toBe("/cmd");
  });

  test("defaults missing step name", () => {
    const p = validateProfile({
      name: "x",
      steps: [{ command: "/a" }, { command: "/b" }],
    });
    expect(p.steps[0]!.name).toBe("step1");
    expect(p.steps[1]!.name).toBe("step2");
  });

  test("preserves per-step overrides", () => {
    const p = validateProfile({
      name: "x",
      steps: [
        {
          name: "plan",
          command: "/plan",
          args: "",
          permissionMode: "plan",
          allowedTools: ["Read"],
          disallowedTools: ["Bash"],
        },
      ],
    });
    expect(p.steps[0]!.permissionMode).toBe("plan");
    expect(p.steps[0]!.allowedTools).toEqual(["Read"]);
    expect(p.steps[0]!.disallowedTools).toEqual(["Bash"]);
  });

  test("rejects missing name", () => {
    expect(() => validateProfile({ steps: [{ command: "/a" }] })).toThrow();
  });

  test("rejects empty steps", () => {
    expect(() => validateProfile({ name: "x", steps: [] })).toThrow();
  });

  test("rejects step without command", () => {
    expect(() => validateProfile({ name: "x", steps: [{ name: "s" }] })).toThrow();
  });

  test("rejects non-object input", () => {
    expect(() => validateProfile(null)).toThrow();
    expect(() => validateProfile("nope")).toThrow();
  });
});

describe("scaffolds", () => {
  test("harness ships /harness-plan, /harness-implement, /harness-evaluate", () => {
    const p = scaffoldHarness("h");
    expect(p.name).toBe("h");
    expect(p.steps.map((s) => s.command)).toEqual([
      "/harness-plan",
      "/harness-implement",
      "/harness-evaluate",
    ]);
    expect(validateProfile(p)).toEqual(p);
  });

  test("openspec ships /opsx:propose, /opsx:apply, /opsx:verify", () => {
    const p = scaffoldOpenspec("o");
    expect(p.steps.map((s) => s.command)).toEqual([
      "/opsx:propose",
      "/opsx:apply",
      "/opsx:verify",
    ]);
    expect(validateProfile(p)).toEqual(p);
  });
});
