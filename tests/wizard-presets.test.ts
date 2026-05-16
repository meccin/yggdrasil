import { describe, test, expect } from "bun:test";
import { PRESETS, getPreset } from "../src/ui/wizard/presets";

describe("PRESETS", () => {
  test("exposes exactly safe/balanced/yolo in that order", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["safe", "balanced", "yolo"]);
  });

  test("safe is dontAsk with git-only Bash + standard read/write set", () => {
    const safe = getPreset("safe");
    expect(safe.permissionMode).toBe("dontAsk");
    expect(safe.allowedTools).toEqual([
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash(git *)",
    ]);
    expect(safe.warning).toBeUndefined();
  });

  test("balanced is acceptEdits with the documented default allowlist", () => {
    const b = getPreset("balanced");
    expect(b.permissionMode).toBe("acceptEdits");
    expect(b.allowedTools).toEqual(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
    expect(b.warning).toBeUndefined();
  });

  test("yolo is bypassPermissions with the default allowlist and a warning", () => {
    const y = getPreset("yolo");
    expect(y.permissionMode).toBe("bypassPermissions");
    expect(y.allowedTools).toEqual(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
    expect(typeof y.warning).toBe("string");
    expect(y.warning!.length).toBeGreaterThan(0);
  });

  test("getPreset throws on unknown id", () => {
    expect(() => getPreset("nope" as never)).toThrow();
  });
});
