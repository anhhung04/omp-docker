/**
 * Live run of the swarm and sandbox tools.
 *
 * Swarm is usually inactive and `sbx` usually absent, so correctness here means
 * "fails with actionable guidance", not "succeeds". Both cases are asserted.
 *
 * Usage: bun run test/swarm-sandbox.ts
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
for (const name of ["docker_swarm", "docker_node", "docker_service", "docker_stack", "docker_sandbox"]) {
  const factory = (await import(`../tools/${name}.ts`)).default as CustomToolFactory;
  for (const tool of [factory(pi)].flat() as CustomTool[]) tools.set(tool.name, tool);
}

async function call(toolName: string, params: Record<string, unknown>, label: string): Promise<CustomToolResult> {
  const tool = tools.get(toolName);
  if (!tool) throw new Error(`tool ${toolName} not loaded`);
  const result = await tool.execute("smoke", params, undefined, {} as never);
  const text = result.content.map((block) => ("text" in block ? block.text : "")).join("\n");
  console.log(`\n### ${label} — ${result.isError ? "ERROR (expected)" : "ok"}`);
  console.log(text.slice(0, 700));
  return result;
}

// Either outcome is valid: active swarms report role/quorum, inactive ones must
// still explain how to proceed instead of echoing a raw daemon error.
const swarmStatus = await call("docker_swarm", { action: "status" }, "swarm status");
const swarmText = swarmStatus.content.map((block) => ("text" in block ? block.text : "")).join("");
const swarmHandled =
  swarmText.includes("not part of a swarm") ||
  swarmText.includes("Swarm state:   active");

await call("docker_node", { action: "ls" }, "node ls");
await call("docker_service", { action: "ls" }, "service ls");
await call("docker_stack", { action: "ls" }, "stack ls");

const sandboxLs = await call("docker_sandbox", { action: "ls" }, "sandbox ls");
const sandboxMissing = sandboxLs.content
  .map((block) => ("text" in block ? block.text : ""))
  .join("")
  .toLowerCase();

const guarded = await call("docker_service", { action: "rm", service: "does-not-exist" }, "service rm without confirm");
const guardedText = guarded.content.map((block) => ("text" in block ? block.text : "")).join("");
const sandboxRmGuarded = await call("docker_sandbox", { action: "rm", sandbox: "nope" }, "sandbox rm without confirm");

console.log("\n--- assertions ---");
const checks: Array<[string, boolean]> = [
  ["swarm status is actionable either active or inactive", swarmHandled],
  ["service rm refuses without confirm", guardedText.includes("confirm=true")],
  [
    "sandbox rm refuses without confirm",
    sandboxRmGuarded.content
      .map((block) => ("text" in block ? block.text : ""))
      .join("")
      .includes("confirm=true"),
  ],
  [
    "sandbox ls gives install guidance or real output",
    sandboxMissing.includes("sbx") || sandboxMissing.includes("docker sandbox"),
  ],
];

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`${passed ? "PASS" : "FAIL"} ${label}`);
  if (!passed) failed += 1;
}
process.exit(failed > 0 ? 1 : 0);
