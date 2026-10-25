import { describe, expect, test } from "bun:test";
import { clamp, getPath, parseJsonLines, requireConfirm, keyValueArgs, table, getPath as resolvePath } from "../tools/_docker";

describe("clamp", () => {
  test("keeps short text unchanged", () => {
    expect(clamp("hello")).toBe("hello");
  });

  test("truncates in the middle and reports the dropped size", () => {
    const value = "a".repeat(100);
    const out = clamp(value, 20);
    expect(out).toContain("[81 chars truncated]");
    expect(out.length).toBeLessThanOrEqual(60);
  });

  test("tail mode keeps the end (build logs)", () => {
    const value = `${"x".repeat(100)}END`;
    const out = clamp(value, 10, "tail");
    expect(out).toContain("END");
  });
});

describe("parseJsonLines", () => {
  test("parses docker json output and skips junk", () => {
    const rows = parseJsonLines<{ Names: string }>(
      '{"Names":"a","ID":"1"}\n{"Names":"b","ID":"2"}\n[WARN] something',
    );
    expect(rows.map((row) => row.Names)).toEqual(["a", "b"]);
  });
});

describe("table", () => {
  test("aligns headers and truncates long cells", () => {
    const body = table(["NAME"], [["x".repeat(60)]], { maxColumnWidth: 10 });
    expect(body).toContain("-".repeat(10));
    expect(body).toContain("……".slice(0, 1));
  });

  test("renders missing cells as empty, not undefined", () => {
    const body = table(["A", "B"], [["a", undefined]]);
    expect(body).not.toContain("undefined");
  });
});

describe("getPath", () => {
  const obj = [{ State: { Health: { Log: [{ ExitCode: 1 }] }, ExitCode: 137 } }];

  test("resolves nested fields", () => {
    expect(resolvePath(obj, "0.State.ExitCode")).toBe(137);
  });

  test("resolves bracket indices", () => {
    expect(resolvePath(obj, "0.State.Health.Log[0].ExitCode")).toBe(1);
  });

  test("returns undefined for unknown paths instead of throwing", () => {
    expect(resolvePath(obj, "0.Nope.Deep")).toBeUndefined();
  });
});

describe("keyValueArgs", () => {
  test("emits flag/value pairs", () => {
    expect(keyValueArgs("-e", ["A=1", "B=2"], "env")).toEqual({ args: ["-e", "A=1", "-e", "B=2"] });
  });

  test("rejects entries without '=' so docker gets a clear error", () => {
    expect(keyValueArgs("-e", ["NOPE"], "env").error).toContain('must be in KEY=VALUE form');
  });
});

describe("requireConfirm", () => {
  test("blocks destructive actions until confirm=true", () => {
    expect(requireConfirm(undefined, "remove volume pgdata")?.isError).toBe(true);
    expect(requireConfirm(true, "remove volume pgdata")).toBeUndefined();
  });
});

describe("getPath on mixed shapes", () => {
  test("rejects array indexing with a non-numeric key", () => {
    expect(getPath([{ a: 1 }], "x")).toBeUndefined();
  });
});
