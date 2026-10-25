/**
 * Live smoke run for the Docker plugin tools against the actual Docker daemon.
 * Loads every tool module, calls it with real arguments, and prints the result text.
 *
 * Usage: bun run test/smoke.ts
 */

import { spawn } from "bun";
import * as zod from "@oh-my-pi/omptype/zod";
import type { CustomTool, CustomToolAPI, CustomToolFactory, CustomToolResult, ExecOptions, ExecResult } from "@oh-my-pi/pi-coding-agent";

const exec = async (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
  const proc = spawn([command, ...args], {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal: options?.signal,
  });
  const timer = options?.timeout
    ? setTimeout(() => {
        proc.kill();
      }, options.timeout)
    : undefined;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { stdout, stderr, code, killed: false };
};

const pi = {
  cwd: process.cwd(),
  exec,
  zod,
  ui: {},
  hasUI: false,
  logger: { error() {}, warn() {}, debug() {}, info() {} },
  pushPendingAction() {},
} as unknown as CustomToolAPI;

const toolsByName = new Map<string, CustomTool>();

for (const name of [
  "docker_container",
  "docker_ps",
  "docker_logs",
  "docker_inspect",
  "docker_exec",
  "docker_run",
  "docker_cp",
  "docker_stats",
  "docker_build",
  "docker_images",
  "docker_compose",
  "docker_network",
  "docker_volume",
  "docker_cleanup",
  "docker_status",
]) {
  const factory = (await import(`../tools/${name}.ts`)).default as CustomToolFactory;
  for (const tool of [factory(pi)].flat() as CustomTool[]) toolsByName.set(tool.name, tool);
}

let failures = 0;

async function call(toolName: string, params: Record<string, unknown>, label: string): Promise<void> {
  const tool = toolsByName.get(toolName);
  if (!tool) {
    console.log(`SKIP ${toolName} (not loaded)`);
    return;
  }
  const run = tool as (typeof tool) & {
    execute(
      id: string,
      params: unknown,
      onUpdate: undefined,
      ctx: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<CustomToolResult>;
  };
  const result = await run.execute("smoke", params, undefined, {});
  const text = result.content.map((block) => ("text" in block ? block.text : "")).join("\n");
  if (result.isError) failures += 1;
  console.log(`\n### ${label} — ${toolName} ${result.isError ? "ERROR" : "ok"}`);
  console.log(text.slice(0, 1_200));
}

const target = process.argv[2];
const shouldRun = (name: string) => !target || name === target;

if (shouldRun("docker_status")) await call("docker_status", {}, "daemon health");
if (shouldRun("docker_ps")) await call("docker_ps", { all: true, limit: 5 }, "containers");
if (shouldRun("docker_images")) await call("docker_images", { limit: 5 }, "images");
if (shouldRun("docker_logs")) await call("docker_logs", { container: "chweb-updater-redis-1", tail: 5 }, "logs");
if (shouldRun("docker_exec")) await call("docker_exec", { container: "chweb-updater-redis-1", command: ["ls", "/"] }, "exec");
if (shouldRun("docker_inspect")) await call("docker_inspect", { target: "chweb-updater-redis-1", path: "State.Status" }, "inspect");
if (shouldRun("docker_network")) await call("docker_network", { action: "ls" }, "networks");
if (shouldRun("docker_volume")) await call("docker_volume", { action: "ls" }, "volumes");
if (shouldRun("docker_cleanup")) await call("docker_cleanup", { action: "report" }, "cleanup report");
if (shouldRun("docker_cleanup")) await call("docker_cleanup", { action: "plan" }, "cleanup plan");
if (shouldRun("docker_stats")) await call("docker_stats", {}, "stats");
if (shouldRun("docker_cp")) await call("docker_cp", { source: "chweb-updater-redis-1:/etc/hostname", destination: "./tmp-hostname" }, "cp out");
if (shouldRun("docker_run")) await call("docker_run", { image: "alpine:latest", command: ["echo", "hello"], detach: false, rm: true }, "run");
if (shouldRun("docker_compose")) await call("docker_compose", { action: "config" }, "compose config");

console.log(`\n${failures} errored step(s)`);
process.exit(failures > 0 ? 1 : 0);
