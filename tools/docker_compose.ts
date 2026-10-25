import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, commandResult, fail, ok, parseJsonLines, requireConfirm, runCompose, streams, table } from "./_docker";

interface ComposePsRow {
  Name: string;
  Service: string;
  State: string;
  Status: string;
  Health?: string;
  ExitCode?: number;
  Ports?: string;
  Image: string;
  Publishers?: Array<{ PublishedPort: number; TargetPort: number; Protocol: string }>;
}

/**
 * Docker Compose project orchestration.
 *
 * Project discovery mirrors compose itself: pass `files` for an explicit -f list,
 * or `projectDir` (defaults to the session cwd) where compose finds its default
 * `compose.yaml`/`docker-compose.yml`.
 */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_compose",
  label: "Docker Compose",
  description:
    "Operate a Docker Compose project. Actions: ps, config (resolved YAML), up, down, start, stop, restart, build, pull, logs, exec, run (one-off), rm. " +
    "Use instead of raw docker_run whenever the workload is defined by a compose file: it handles dependency order, networks and project naming. " +
    "`up` is detached by default; `config` validates the file and shows the merged result. Destructive actions (down, rm) require confirm=true.",
  approval: (args) => {
    // The harness passes parsed params but the callback type is `unknown`.
    const action = typeof args === "object" && args !== null && "action" in args
      ? (args as { action?: string }).action
      : undefined;
    if (action === "ps" || action === "config" || action === "logs" || action === "pull" || action === "build") {
      return "read";
    }
    return { tier: "exec", reason: `docker compose ${action ?? "?"} changes project state` };
  },
  parameters: pi.zod.object({
    action: pi.zod
      .enum(["ps", "config", "up", "down", "start", "stop", "restart", "build", "pull", "logs", "exec", "run", "rm"])
      .describe("Compose operation"),
    projectDir: pi.zod
      .string()
      .optional()
      .describe("Directory containing the compose file (default: session cwd)"),
    files: pi.zod.array(pi.zod.string()).optional().describe("Compose files (-f), in order"),
    projectName: pi.zod.string().optional().describe("Project name (-p)"),
    profiles: pi.zod.array(pi.zod.string()).optional().describe("Compose profiles to enable (--profile)"),
    envFile: pi.zod.string().optional().describe("Env file (--env-file)"),
    services: pi.zod.array(pi.zod.string()).optional().describe("Service names to target"),
    detach: pi.zod.boolean().optional().describe("For up: detached (default true)"),
    build: pi.zod.boolean().optional().describe("For up: build images first (--build)"),
    noDeps: pi.zod.boolean().optional().describe("For up/run: do not start linked services (--no-deps)"),
    removeVolumes: pi.zod.boolean().optional().describe("For down: also remove named volumes (-v)"),
    removeImages: pi.zod.enum(["all", "local"]).optional().describe("For down: remove images (--rmi)"),
    removeOrphans: pi.zod.boolean().optional().describe("For down/up: remove orphan containers"),
    tail: pi.zod.number().optional().describe("For logs: trailing lines per service (default 200)"),
    since: pi.zod.string().optional().describe("For logs: start time window"),
    command: pi.zod
      .union([pi.zod.string(), pi.zod.array(pi.zod.string())])
      .optional()
      .describe("For exec/run: command argv (array preferred) or string"),
    entrypoint: pi.zod.string().optional().describe("For run: override entrypoint"),
    rm: pi.zod.boolean().optional().describe("For run: remove container after exit (--rm, default true)"),
    env: pi.zod.array(pi.zod.string()).optional().describe("For run: env KEY=VALUE entries"),
    noCache: pi.zod.boolean().optional().describe("For build: --no-cache"),
    confirm: pi.zod.boolean().optional().describe("Required for down/rm"),
    timeoutMs: pi.zod.number().optional().describe("Timeout in ms (default 300000)"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const {
      action,
      projectDir,
      files,
      projectName,
      profiles,
      envFile,
      services,
      detach = true,
      build,
      noDeps,
      removeVolumes,
      removeImages,
      removeOrphans,
      tail,
      since,
      command,
      entrypoint,
      rm,
      env,
      noCache,
      confirm,
      timeoutMs,
    } = params;

    if (action === "down" || action === "rm") {
      const refusal = requireConfirm(confirm, `${action} the compose project`);
      if (refusal) return refusal;
    }

    const cwd = projectDir ?? pi.cwd;
    const args: string[] = [];
    if (projectName) args.push("--project-name", projectName);
    for (const file of files ?? []) args.push("--file", file);
    for (const profile of profiles ?? []) args.push("--profile", profile);
    if (envFile) args.push("--env-file", envFile);

    const commandArgs = (): string[] => {
      if (!command) return [];
      if (Array.isArray(command)) return command;
      return ["sh", "-lc", command];
    };

    switch (action) {
      case "ps": {
        const res = await runCompose(pi.exec, [...args, "ps", "--format", "json", "--all"], {
          signal,
          cwd,
          timeoutMs: 60_000,
        });
        if (res.code !== 0) return commandResult("docker compose ps", res);
        const rows = parseJsonLines<ComposePsRow>(res.stdout);
        if (rows.length === 0) {
          return ok("No containers for this compose project (not started yet?)", { count: 0 });
        }
        const body = table(
          ["SERVICE", "NAME", "STATE", "HEALTH", "STATUS", "PORTS"],
          rows.map((row) => [
            row.Service,
            row.Name,
            row.State,
            row.Health || "-",
            row.Status,
            (row.Publishers ?? [])
              .filter((p) => p.PublishedPort)
              .map((p) => `${p.PublishedPort}->${p.TargetPort}/${p.Protocol}`)
              .join(", ") || row.Ports || "-",
          ]),
          { maxColumnWidth: 44 },
        );
        return ok(`${rows.length} compose container(s)\n\n${body}`, {
          count: rows.length,
          services: rows.map((row) => ({
            service: row.Service,
            name: row.Name,
            state: row.State,
            health: row.Health,
            status: row.Status,
            exitCode: row.ExitCode,
          })),
        });
      }
      case "config": {
        const res = await runCompose(pi.exec, [...args, "config"], { signal, cwd, timeoutMs: 60_000 });
        return commandResult("docker compose config", res, { maxChars: 16_000 });
      }
      case "up": {
        const upArgs = [...args, "up"];
        if (detach) upArgs.push("--detach");
        if (build) upArgs.push("--build");
        if (noDeps) upArgs.push("--no-deps");
        if (removeOrphans) upArgs.push("--remove-orphans");
        if (services?.length) upArgs.push(...services);
        const res = await runCompose(pi.exec, upArgs, { signal, cwd, timeoutMs: timeoutMs ?? 300_000 });
        return commandResult(`docker compose up${detach ? " (detached)" : ""}`, res, {
          note: detach ? "verify with action='ps' and action='logs'" : undefined,
        });
      }
      case "down": {
        const downArgs = [...args, "down"];
        if (removeVolumes) downArgs.push("--volumes");
        if (removeImages) downArgs.push("--rmi", removeImages);
        if (removeOrphans) downArgs.push("--remove-orphans");
        const res = await runCompose(pi.exec, downArgs, { signal, cwd, timeoutMs: 180_000 });
        return commandResult("docker compose down", res);
      }
      case "start":
      case "stop":
      case "restart":
      case "rm": {
        const opArgs = [...args, action, ...(action === "rm" ? ["--force"] : [])];
        if (services?.length) opArgs.push(...services);
        const res = await runCompose(pi.exec, opArgs, { signal, cwd, timeoutMs: 180_000 });
        return commandResult(`docker compose ${action}`, res);
      }
      case "build": {
        const buildArgs = [...args, "build"];
        if (noCache) buildArgs.push("--no-cache");
        if (services?.length) buildArgs.push(...services);
        const res = await runCompose(pi.exec, buildArgs, { signal, cwd, timeoutMs: timeoutMs ?? 600_000 });
        return commandResult("docker compose build", res);
      }
      case "pull": {
        const pullArgs = [...args, "pull"];
        if (services?.length) pullArgs.push(...services);
        const res = await runCompose(pi.exec, pullArgs, { signal, cwd, timeoutMs: 600_000 });
        return commandResult("docker compose pull", res);
      }
      case "logs": {
        const logArgs = [...args, "logs", "--no-color"];
        logArgs.push("--tail", String(tail ?? 200));
        if (since) logArgs.push("--since", since);
        if (services?.length) logArgs.push(...services);
        const res = await runCompose(pi.exec, logArgs, { signal, cwd, timeoutMs: 60_000 });
        if (res.code !== 0) return commandResult("docker compose logs", res);
        const body = clamp(streams(res), 16_000, "tail");
        return ok(body || "(no log output)");
      }
      case "exec": {
        if (!services?.length) return fail("action 'exec' requires services (the first one is used)");
        const execArgs = [...args, "exec", services[0]!, ...commandArgs()];
        if (execArgs.at(-1) === "exec") return fail("action 'exec' requires a command");
        const res = await runCompose(pi.exec, execArgs, { signal, cwd, timeoutMs: timeoutMs ?? 120_000 });
        return commandResult(`docker compose exec ${services[0]}`, res);
      }
      case "run": {
        if (!services?.length) return fail("action 'run' requires services (the first one is used)");
        const runArgs = [...args, "run"];
        if (rm !== false) runArgs.push("--rm");
        if (noDeps) runArgs.push("--no-deps");
        if (entrypoint) runArgs.push("--entrypoint", entrypoint);
        for (const entry of env ?? []) {
          if (!entry.includes("=")) return fail(`env entry ${JSON.stringify(entry)} must be KEY=VALUE`);
          runArgs.push("-e", entry);
        }
        runArgs.push(services[0]!, ...commandArgs());
        const res = await runCompose(pi.exec, runArgs, { signal, cwd, timeoutMs: timeoutMs ?? 300_000 });
        return commandResult(`docker compose run ${services[0]}`, res);
      }
    }

    return fail(`Refusing to run unsupported compose action: ${String(action)}`);
  },
});

export default factory;