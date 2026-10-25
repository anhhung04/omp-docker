import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, commandResult, keyValueArgs, runDocker } from "./_docker";

/**
 * Execute a command inside a running container.
 *
 * Arguments are passed as an argv array by default so quoting is never the caller's
 * problem; `shell=true` wraps the single `command` string in `sh -lc` when shell
 * features (pipes, globs, &&) are genuinely required.
 */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_exec",
  label: "Docker Exec",
  description:
    "Run a command inside a RUNNING container and return stdout/stderr/exit code. " +
    "Pass `command` as an argv array (preferred, no quoting needed), or set shell=true with a single string for pipelines/&&. " +
    "Use to inspect config files, run migrations, check env vars, or query the app from inside its network namespace. " +
    "Containers that are stopped must be started first; for one-off commands use docker_run instead.",
  approval: { tier: "exec", reason: "Runs an arbitrary command inside a container" },
  parameters: pi.zod.object({
    container: pi.zod.string().describe("Running container name or ID"),
    command: pi.zod
      .union([pi.zod.string(), pi.zod.array(pi.zod.string())])
      .describe("Command to run: argv array (preferred) or a string when shell=true"),
    shell: pi.zod
      .boolean()
      .optional()
      .describe("Wrap a string command in `sh -lc` (needed for pipes, globs, $VAR, &&)"),
    workdir: pi.zod.string().optional().describe("Working directory inside the container (-w)"),
    user: pi.zod.string().optional().describe("User or uid[:gid] (-u)"),
    env: pi.zod
      .array(pi.zod.string())
      .optional()
      .describe("Environment overrides as KEY=VALUE entries"),
    detach: pi.zod.boolean().optional().describe("Run detached (-d) and return immediately"),
    timeoutMs: pi.zod.number().optional().describe("Timeout in ms (default 120000)"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const { container, command, shell, workdir, user, env, detach, timeoutMs } = params;

    const kv = keyValueArgs("-e", env, "env");
    if (kv.error) return commandResult("docker exec", { command: "", stdout: "", stderr: kv.error, code: 2, killed: false, timedOut: false });

    const args = ["exec"];
    if (detach) args.push("--detach");
    if (workdir) args.push("--workdir", workdir);
    if (user) args.push("--user", user);
    args.push(...kv.args);
    args.push(container);

    if (typeof command === "string") {
      if (!shell) {
        return commandResult("docker exec", {
          command: "",
          stdout: "",
          stderr:
            "Refusing to guess tokenisation. Pass command as an argv array, or set shell=true to run the string via `sh -lc`.",
          code: 2,
          killed: false,
          timedOut: false,
        });
      }
      args.push("sh", "-lc", command);
    } else {
      if (command.length === 0) {
        return commandResult("docker exec", {
          command: "",
          stdout: "",
          stderr: "command array must not be empty",
          code: 2,
          killed: false,
          timedOut: false,
        });
      }
      args.push(...command);
    }

    const res = await runDocker(pi.exec, args, {
      signal,
      cwd: pi.cwd,
      timeoutMs: timeoutMs ?? 120_000,
    });
    const shown = detach
      ? clamp(`${res.stdout}${res.stderr}`, 4_000)
      : clamp(`${res.stdout}${res.stderr ? `\n--- stderr ---\n${res.stderr}` : ""}`, 16_000);
    if (res.code !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `docker exec ${container} (exit ${res.code}${res.timedOut ? ", timed out" : ""})\n${shown || "(no output)"}`,
          },
        ],
        isError: true,
        details: { container, exitCode: res.code },
      };
    }
    return {
      content: [{ type: "text", text: `docker exec ${container} (exit 0)\n${shown || "(no output)"}` }],
      details: { container, exitCode: 0 },
    };
  },
});

export default factory;
