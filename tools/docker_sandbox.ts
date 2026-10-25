import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import type { ExecFn, ExecResult, RunOptions, RunResult } from "./_docker";
import { clamp, ok, fail, keyValueArgs, requireConfirm } from "./_docker";

/**
 * Docker Sandboxes — isolated microVMs for running coding agents.
 *
 * Two CLIs provide the same operations:
 *   - `sbx`            — current standalone CLI
 *   - `docker sandbox` — Docker Desktop 4.58 and earlier, now deprecated
 *
 * Binary resolution mirrors the docker helper:
 *   1. $DOCKER_SANDBOX_BIN — full command line, e.g. "sbx" or "docker sandbox"
 *   2. `sbx` on PATH
 */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_sandbox",
  label: "Docker Sandbox",
  description:
    "Manage Docker Sandboxes — isolated microVMs for running coding agents. Actions: ls, run, create, exec, cp, logs, " +
    "ports, stop, rm, prune, templates. A sandbox gives an agent its own microVM with a rootless Docker daemon, mounted " +
    "workspaces, network governance and credential proxying, so risky or long-running agent work never touches the host " +
    "or your real credentials. Use docker_sandbox action='run' when delegating agent tasks; use action='exec' to inspect " +
    "a running sandbox; action='rm' (with confirm=true) to destroy one and everything inside it.",
  approval: (args) => {
    // The harness passes parsed params but the callback type is `unknown`.
    const action = typeof args === "object" && args !== null && "action" in args
      ? (args as { action?: string }).action
      : undefined;
    if (action === "rm" || action === "prune") {
      return { tier: "write", reason: "Destroys a sandbox and its contents" };
    }
    if (action === "run" || action === "create" || action === "exec" || action === "stop") {
      return { tier: "exec", reason: `docker sandbox ${action} starts or mutates a sandbox` };
    }
    return "read";
  },
  parameters: pi.zod.object({
    action: pi.zod
      .enum(["ls", "run", "create", "exec", "cp", "logs", "ports", "stop", "rm", "prune", "templates"])
      .describe("Sandbox operation"),
    sandbox: pi.zod.string().optional().describe("Sandbox name or ID (required for exec/cp/logs/ports/stop/rm)"),
    agent: pi.zod.string().optional().describe("For run/create: agent to start, e.g. claude, codex, gemini, kiro, copilot"),
    workspaces: pi.zod
      .array(pi.zod.string())
      .optional()
      .describe("Host paths to mount; the first is primary. Omit to create a mountless sandbox"),
    name: pi.zod.string().optional().describe("For run/create: sandbox name (needed to reattach, exec, cp)"),
    template: pi.zod.string().optional().describe("For run/create: template image reference (-t/--template)"),
    clone: pi.zod.boolean().optional().describe("For run/create: git clone inside the sandbox instead of bind-mounting the workspace"),
    detach: pi.zod.boolean().optional().describe("For run: start and return without attaching an agent session"),
    removeOnExit: pi.zod.boolean().optional().describe("For run: remove the sandbox when the agent exits (throwaway session)"),
    env: pi.zod.array(pi.zod.string()).optional().describe("Env entries KEY=VALUE (a bare KEY copies from the host)"),
    command: pi.zod.array(pi.zod.string()).optional().describe("For exec: command argv array"),
    workdir: pi.zod.string().optional().describe("For exec: working directory inside the sandbox"),
    source: pi.zod.string().optional().describe("For cp: source (host path or 'sandbox:/abs/path')"),
    destination: pi.zod.string().optional().describe("For cp: destination (host path or 'sandbox:/abs/path')"),
    publish: pi.zod.array(pi.zod.string()).optional().describe("Port mappings 'hostPort:sandboxPort' (host port optional)"),
    unpublish: pi.zod.array(pi.zod.string()).optional().describe("For ports: mappings to remove"),
    lines: pi.zod.number().optional().describe("For logs: trailing lines (default 200)"),
    timeoutMs: pi.zod.number().optional().describe("Timeout for exec/run in ms (default 300000)"),
    maxChars: pi.zod.number().optional().describe("Output cap (default 16000)"),
    dryRun: pi.zod.boolean().optional().describe("For prune: list what would be removed instead of removing"),
    confirm: pi.zod.boolean().optional().describe("Required for rm, and for a prune that is not a dry run"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const {
      action,
      sandbox,
      agent,
      workspaces,
      name,
      template,
      clone,
      detach,
      removeOnExit,
      env,
      command,
      workdir,
      source,
      destination,
      publish,
      unpublish,
      lines,
      timeoutMs,
      maxChars = 16_000,
      dryRun,
      confirm,
    } = params;

    if (action === "rm") {
      const refusal = requireConfirm(confirm, `remove sandbox ${sandbox ?? "(unspecified)"} and everything inside it`);
      if (refusal) return refusal;
    }
    if (action === "prune" && !dryRun) {
      const refusal = requireConfirm(confirm, "prune stopped sandboxes");
      if (refusal) return refusal;
    }
    const needsTarget = !["ls", "templates", "run", "create", "prune"].includes(action);
    if (needsTarget && !sandbox) return fail(`action '${action}' requires 'sandbox'`);
    if ((action === "run" || action === "create") && !agent) {
      return fail(`action '${action}' requires 'agent' (e.g. claude, codex, gemini, kiro)`);
    }

    const envArgs = keyValueArgs("-e", env, "env");
    if (envArgs.error) return fail(envArgs.error);

    let args: string[] = [];
    switch (action) {
      case "ls":
        args = ["ls"];
        break;
      case "templates":
        args = ["templates"];
        break;
      case "run":
      case "create": {
        args = [action];
        if (name) args.push("--name", name);
        if (template) args.push("--template", template);
        if (clone) args.push("--clone");
        if (detach) args.push("--detach");
        if (removeOnExit) args.push("--rm");
        args.push(...envArgs.args);
        for (const port of publish ?? []) args.push("--publish", port);
        args.push(agent!);
        for (const workspace of workspaces ?? []) args.push(workspace);
        break;
      }
      case "exec": {
        if (!command || command.length === 0) return fail("action 'exec' requires 'command' (argv array)");
        args = ["exec", ...envArgs.args];
        if (workdir) args.push("--workdir", workdir);
        args.push(sandbox!, ...command);
        break;
      }
      case "cp": {
        if (!source || !destination) return fail("action 'cp' requires 'source' and 'destination'");
        if (!`${source}:${destination}`.includes(":")) {
          return fail("One side of a sandbox copy must be 'sandbox:/abs/path'.");
        }
        args = ["cp", source, destination];
        break;
      }
      case "logs":
        args = ["logs", "--tail", String(lines ?? 200), sandbox!];
        break;
      case "ports": {
        args = ["ports", sandbox!];
        for (const port of publish ?? []) args.push("--publish", port);
        for (const port of unpublish ?? []) args.push("--unpublish", port);
        break;
      }
      case "stop":
        args = ["stop", sandbox!];
        break;
      case "rm":
        args = ["rm", sandbox!];
        break;
      case "prune":
        args = dryRun ? ["prune", "--dry-run"] : ["prune"];
        break;
    }

    const res = await runSandbox(pi.exec, args, {
      signal,
      cwd: pi.cwd,
      timeoutMs: timeoutMs ?? 300_000,
    });
    const combined = `${res.stdout}${res.stderr}`.trim();

    if (res.code === 127 || /command not found|no such file or directory|is not recognized/i.test(combined)) {
      return fail(
        `docker sandbox ${action} failed: the sandbox CLI (${res.command.split(" ")[0]}) is not installed here.\n\n` +
          "Docker Sandboxes ships as the standalone `sbx` CLI (Docker Desktop 4.58+ replaced the deprecated " +
          "`docker sandbox` form). Install it from https://docs.docker.com/ai/sandboxes/, or point " +
          "DOCKER_SANDBOX_BIN at whatever runs it on this host (e.g. DOCKER_SANDBOX_BIN=\"docker sandbox\").",
      );
    }

    if (res.code !== 0) {
      return fail(`docker sandbox ${action} failed (exit ${res.code}${res.timedOut ? ", timed out" : ""}):\n${clamp(combined, maxChars)}`);
    }
    const body = clamp(combined, maxChars, action === "logs" ? "tail" : "middle");
    return ok(body || `(docker sandbox ${action}: no output)`, { action, sandbox });
  },
});

export default factory;

/** Sandbox binary resolution mirrors the docker helper: env override, then PATH. */
function resolveSandboxBin(): { cmd: string; baseArgs: string[] } {
  const raw = process.env.DOCKER_SANDBOX_BIN?.trim();
  if (raw) {
    const [cmd, ...baseArgs] = raw.split(/\s+/);
    if (cmd) return { cmd, baseArgs };
  }
  return { cmd: "sbx", baseArgs: [] };
}

async function runSandbox(exec: ExecFn, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { cmd, baseArgs } = resolveSandboxBin();
  const argv = [...baseArgs, ...args];
  // A missing CLI throws ENOENT in some hosts; report it as exit 127 (shell convention)
  // so the caller can turn it into install guidance instead of an unhandled error.
  let res: ExecResult;
  try {
    res = await exec(cmd, argv, {
      signal: opts.signal,
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 120_000,
    });
  } catch (error) {
    return {
      stdout: "",
      stderr: `Executable not found in $PATH: "${cmd}" — ${(error as Error).message}`,
      code: 127,
      killed: false,
      command: [cmd, ...argv].join(" "),
      timedOut: false,
    };
  }
  return {
    ...res,
    command: [cmd, ...argv].join(" "),
    timedOut: res.killed && !opts.signal?.aborted,
  };
}
