/**
 * Live smoke run: exercises every Docker plugin tool against the real daemon.
 *
 * Targets are discovered at runtime (first running container, an alpine-ish image)
 * so it works on any machine with Docker; steps that need something unavailable
 * are reported as SKIP instead of failing.
 *
 * Usage: bun run test/smoke.ts [tool-name]
 */

import { spawn } from "bun";
import * as zod from "@oh-my-pi/omptype/zod";
import type {
  CustomTool,
  CustomToolAPI,
  CustomToolFactory,
  CustomToolResult,
  ExecOptions,
  ExecResult,
} from "@oh-my-pi/pi-coding-agent";

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

const tools = new Map<string, CustomTool>();
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
  for (const tool of [factory(pi)].flat() as CustomTool[]) tools.set(tool.name, tool);
}

let errors = 0;
let skipped = 0;

async function call(toolName: string, params: Record<string, unknown>, label: string): Promise<string | undefined> {
  const tool = tools.get(toolName);
  if (!tool) {
    console.log(`\n### ${label} — SKIP (${toolName} not loaded)`);
    skipped += 1;
    return undefined;
  }
  const result: CustomToolResult = await tool.execute("smoke", params, undefined, {} as never);
  const text = result.content.map((block) => ("text" in block ? block.text : "")).join("\n");
  if (result.isError) errors += 1;
  console.log(`\n### ${label} — ${toolName} ${result.isError ? "ERROR" : "ok"}`);
  console.log(text.slice(0, 900));
  return text;
}

function skip(label: string, reason: string): undefined {
  console.log(`\n### ${label} — SKIP (${reason})`);
  skipped += 1;
  return undefined;
}

const only = process.argv[2];
const wanted = (name: string) => !only || name === only;

// Discover what this machine actually has before choosing targets.
// Ask docker directly for a target: prefer a container that has been Up for a
// while over one that just started and may be gone by the next step.
const listed = await exec("docker", ["ps", "--filter", "status=running", "--format", "{{.Names}}\t{{.Status}}"], { timeout: 30_000 });
const candidates = listed.stdout
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const [name, status] = line.split("\t");
    return { name: name ?? "", status: status ?? "" };
  });
const firstRunning = candidates.find((row) => /Up \d+ (hours|minutes)/.test(row.status))?.name ?? candidates[0]?.name;

if (wanted("docker_status")) await call("docker_status", {}, "daemon health");
if (wanted("docker_images")) await call("docker_images", { limit: 5 }, "images");

if (wanted("docker_logs")) {
  if (firstRunning) await call("docker_logs", { container: firstRunning, tail: 5 }, `logs ${firstRunning}`);
  else skip("logs", "no running container found");
}
if (wanted("docker_exec")) {
  if (firstRunning) await call("docker_exec", { container: firstRunning, command: ["ls", "/"] }, `exec ${firstRunning}`);
  else skip("exec", "no running container found");
}
if (wanted("docker_inspect")) {
  if (firstRunning) await call("docker_inspect", { target: firstRunning, path: "State.Status" }, `inspect ${firstRunning}`);
  else skip("inspect", "no running container found");
}
if (wanted("docker_stats")) await call("docker_stats", {}, "stats");
if (wanted("docker_network")) await call("docker_network", { action: "ls" }, "networks");
if (wanted("docker_volume")) await call("docker_volume", { action: "ls" }, "volumes");
if (wanted("docker_cleanup")) await call("docker_cleanup", { action: "report" }, "cleanup report");
if (wanted("docker_cleanup")) await call("docker_cleanup", { action: "plan" }, "cleanup plan");

if (wanted("docker_compose")) {
  const composeFiles = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];
  const found = (await Promise.all(composeFiles.map(async (file) => ((await Bun.file(file).exists()) ? file : undefined)))).find(
    (file) => file !== undefined,
  );
  if (found) await call("docker_compose", { action: "config" }, "compose config");
  else skip("compose config", `no compose file in ${process.cwd()}`);
}

if (wanted("docker_cp")) {
  if (firstRunning) {
    await call("docker_cp", { source: `${firstRunning}:/etc/hostname`, destination: "./smoke-hostname" }, "cp out");
    const copied = Bun.file("./smoke-hostname");
    if (await copied.exists()) await copied.delete();
  } else skip("cp", "no running container found");
}

if (wanted("docker_build") || wanted("docker_run")) {
  await Bun.write("./smoke.Dockerfile", "FROM alpine:latest\nRUN echo built > /built\nCMD [\"cat\", \"/built\"]\n");
  const built = wanted("docker_build")
    ? await call("docker_build", { context: ".", dockerfile: "smoke.Dockerfile", tag: ["omp-docker-smoke:latest"] }, "build")
    : undefined;
  if (wanted("docker_run")) {
    if (built && !built.includes("ERROR")) {
      await call("docker_run", { image: "omp-docker-smoke:latest", rm: true, detach: false }, "run built image");
    } else skip("run built image", "build step did not produce an image");
  }
  const leftover = Bun.file("./smoke.Dockerfile");
  if (await leftover.exists()) await leftover.delete();
}

console.log(`\n${errors} errored, ${skipped} skipped`);
process.exit(errors > 0 ? 1 : 0);
