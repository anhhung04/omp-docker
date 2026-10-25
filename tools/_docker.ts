/**
 * Shared plumbing for the Docker plugin tools.
 *
 * Every tool shells out to the Docker CLI rather than speaking the Engine API
 * directly: the CLI already handles contexts, credential helpers, the Compose
 * plugin and version negotiation, so the plugin tracks whatever Docker the user
 * has installed.
 *
 * Binary resolution:
 *   1. $DOCKER_BIN — full command line, e.g. "docker" or "podman-docker"
 *   2. `docker` on PATH
 *
 * $DOCKER_HOST and Docker contexts are honoured by the CLI itself.
 */

import type { AgentToolResult, ExecOptions, ExecResult } from "@oh-my-pi/pi-coding-agent";

export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export interface RunResult extends ExecResult {
  /** Human-readable command that was executed. */
  command: string;
  /** True when the process was killed by our timeout rather than the caller's abort signal. */
  timedOut: boolean;
}

export interface RunOptions {
  signal?: AbortSignal;
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CHARS = 16_000;

export function resolveDockerBin(): { cmd: string; baseArgs: string[] } {
  const raw = process.env.DOCKER_BIN?.trim();
  if (raw) {
    const [cmd, ...baseArgs] = raw.split(/\s+/);
    if (cmd) return { cmd, baseArgs };
  }
  return { cmd: "docker", baseArgs: [] };
}

function displayArg(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export function formatCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].map(displayArg).join(" ");
}

export async function runDocker(
  exec: ExecFn,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const { cmd, baseArgs } = resolveDockerBin();
  const argv = [...baseArgs, ...args];
  const res = await exec(cmd, argv, {
    signal: opts.signal,
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  return {
    ...res,
    command: formatCommand(cmd, argv),
    timedOut: res.killed && !opts.signal?.aborted,
  };
}

export async function runCompose(
  exec: ExecFn,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return runDocker(exec, ["compose", ...args], opts);
}

export function ok(body: string, details?: unknown): AgentToolResult {
  return { content: [{ type: "text", text: body }], details };
}

export function fail(body: string): AgentToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

/** Truncate long output while keeping both the start and the end. */
export function clamp(
  value: string,
  max = DEFAULT_MAX_CHARS,
  mode: "middle" | "tail" = "middle",
): string {
  if (value.length <= max) return value;
  if (mode === "tail") {
    return `... [${value.length - max} chars truncated] ...\n${value.slice(-max)}`;
  }
  const keep = Math.min(max, value.length);
  const head = value.slice(0, Math.floor(keep * 0.4));
  const tail = value.slice(-Math.floor(keep * 0.55));
  const notice = `\n... [${value.length - head.length - tail.length} chars truncated] ...\n`;
  return `${head}${notice}${tail}`;
}

/** Merge stdout and stderr without pretending the interleaving is preserved. */
export function streams(res: { stdout: string; stderr: string }): string {
  const out = res.stdout.replace(/\s+$/, "");
  const err = res.stderr.replace(/\s+$/, "");
  if (out && err) return `${out}\n--- stderr ---\n${err}`;
  return out || err;
}

export function daemonHint(res: { stderr: string; stdout: string }): string {
  const combined = `${res.stderr}\n${res.stdout}`;
  if (/Cannot connect to the Docker daemon/i.test(combined)) {
    return (
      "\n\nDocker daemon is unreachable. Check `docker info`, $DOCKER_HOST " +
      "(default unix:///var/run/docker.sock), and that the current user is in the docker group " +
      "or has rootless Docker running."
    );
  }
  if (/permission denied while trying to connect/i.test(combined)) {
    return (
      "\n\nPermission denied on the Docker socket. Add the user to the docker group " +
      "(`sudo usermod -aG docker $USER`, then re-login) or point $DOCKER_HOST at an accessible socket."
    );
  }
  return "";
}

/**
 * Result for a command whose exit code matters (exec/run/build/...).
 * Non-zero exit is reported as an error, but the output is still included.
 */
export function commandResult(
  action: string,
  res: RunResult,
  opts: { maxChars?: number; mode?: "middle" | "tail"; note?: string } = {},
): AgentToolResult {
  const body = clamp(streams(res), opts.maxChars ?? DEFAULT_MAX_CHARS, opts.mode ?? "middle");
  const status = `exit ${res.code}${res.timedOut ? ", timed out" : ""}`;
  const header = `${action} (${status})`;
  if (res.code !== 0) {
    return fail(`${header}\n${body || "(no output)"}${daemonHint(res)}`);
  }
  return ok(`${header}${opts.note ? ` — ${opts.note}` : ""}\n${body || "(no output)"}`);
}

export function parseJsonLines<T = unknown>(value: string): T[] {
  const rows: T[] = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      // Docker occasionally emits non-JSON warnings on stdout; ignore them.
    }
  }
  return rows;
}

export function tryParseJson<T = unknown>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/** Markdown table with per-column truncation; keeps agent context small. */
export function table(
  headers: string[],
  rows: Array<Array<string | number | undefined | null>>,
  opts: { maxColumnWidth?: number } = {},
): string {
  const width = opts.maxColumnWidth ?? 48;
  const cells = rows.map((row) =>
    headers.map((_, i) => {
      const raw = row[i];
      const value = raw === undefined || raw === null ? "" : String(raw);
      const flat = value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
      return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
    }),
  );
  const widths = headers.map((h, i) =>
    Math.min(width, Math.max(h.length, ...cells.map((row) => row[i]?.length ?? 0))),
  );
  const render = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(" | ").trimEnd();
  const lines = [render(headers), widths.map((w) => "-".repeat(w)).join(" | ")];
  for (const row of cells) lines.push(render(row));
  return lines.join("\n");
}

/** Resolve "0.State.Health.Log[0]" / "[0].State" against parsed JSON. */
export function getPath(value: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((part) => part.length > 0);
  let current: unknown = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Validate "KEY=VALUE" style lists (env, build args, labels) before invoking Docker,
 * so the error points at the offending entry instead of a generic CLI failure.
 */
export function keyValueArgs(
  flag: string,
  values: string[] | undefined,
  label: string,
): { args: string[]; error?: string } {
  const args: string[] = [];
  for (const value of values ?? []) {
    if (!value.includes("=")) {
      return { args, error: `${label} entry ${JSON.stringify(value)} must be in KEY=VALUE form` };
    }
    args.push(flag, value);
  }
  return { args };
}

export function requireConfirm(confirm: boolean | undefined, action: string): AgentToolResult | undefined {
  if (confirm) return undefined;
  return fail(
    `Refusing to ${action} without confirm=true. ` +
      "Inspect the target first, then re-run with confirm=true if removal is intended.",
  );
}

export function safeRegex(pattern: string): { regex?: RegExp; error?: string } {
  try {
    return { regex: new RegExp(pattern) };
  } catch (error) {
    return { error: `Invalid regular expression: ${(error as Error).message}` };
  }
}

export function dockerUnavailable(res: RunResult): boolean {
  return /Cannot connect to the Docker daemon|permission denied while trying to connect/i.test(
    `${res.stderr}\n${res.stdout}`,
  );
}
