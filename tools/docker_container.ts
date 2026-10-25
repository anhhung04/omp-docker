import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { commandResult, requireConfirm, runDocker } from "./_docker";

/** Container lifecycle transitions on existing containers. */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_container",
  label: "Docker Container Control",
  description:
    "Start, stop, restart, pause, unpause, kill, or remove existing containers (by name or ID). " +
    "Use after docker_ps when the container already exists; docker_run creates new ones. " +
    "`rm` requires confirm=true and refuses running containers unless force=true.",
  approval: (args) => {
    // The harness passes parsed params but the callback type is `unknown`.
    const action = typeof args === "object" && args !== null && "action" in args
      ? (args as { action?: string }).action
      : undefined;
    if (action === "start" || action === "stop" || action === "restart" || action === "pause" || action === "unpause") {
      return { tier: "exec", reason: `docker ${action} changes container state` };
    }
    return { tier: "write", reason: `docker ${action ?? "rm"} destroys container state` };
  },
  parameters: pi.zod.object({
    action: pi.zod
      .enum(["start", "stop", "restart", "pause", "unpause", "kill", "rm"])
      .describe("Lifecycle operation"),
    containers: pi.zod.array(pi.zod.string()).describe("Container names or IDs"),
    timeoutSec: pi.zod.number().optional().describe("Grace period before SIGKILL for stop/restart (default 10)"),
    signal: pi.zod.string().optional().describe("Signal for kill, e.g. SIGHUP (default SIGKILL)"),
    force: pi.zod.boolean().optional().describe("For rm: force removal of running containers (-f)"),
    volumes: pi.zod.boolean().optional().describe("For rm: remove anonymous volumes (-v)"),
    confirm: pi.zod.boolean().optional().describe("Required for rm"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const { action, containers, timeoutSec, signal: killSignal, force, volumes, confirm } = params;
    if (containers.length === 0) return commandResult("docker container", { command: "", stdout: "", stderr: "containers must not be empty", code: 2, killed: false, timedOut: false });
    if (action === "rm") {
      const refusal = requireConfirm(confirm, `remove ${containers.join(", ")}`);
      if (refusal) return refusal;
    }

    const args = [action];
    if (action === "stop" || action === "restart") args.push("--time", String(timeoutSec ?? 10));
    if (action === "kill" && killSignal) args.push("--signal", killSignal);
    if (action === "rm") {
      if (force) args.push("--force");
      if (volumes) args.push("--volumes");
    }
    args.push(...containers);

    const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 180_000 });
    return commandResult(`docker ${action}`, res);
  },
});

export default factory;