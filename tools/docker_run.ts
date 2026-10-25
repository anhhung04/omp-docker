import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, commandResult, keyValueArgs, runDocker } from "./_docker";

/**
 * Create and start a container.
 *
 * Detached by default: agents usually want a service up and then to inspect it with
 * docker_ps/docker_logs instead of blocking on a foreground process.
 */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_run",
  label: "Docker Run",
  description:
    "Create and start a container from an image. Detached by default (returns the container ID); set detach=false to run to completion and capture output. " +
    "Supports ports, bind/anonymous volumes, env, entrypoint override, network, restart policy, labels, memory/cpu limits. " +
    "Use for one-off commands (detach=false, rm=true) or to bring up a single service. For multi-service stacks use docker_compose.",
  approval: { tier: "exec", reason: "Starts a container with caller-specified image and mounts" },
  parameters: pi.zod.object({
    image: pi.zod.string().describe("Image reference, e.g. postgres:16 or registry/app:tag"),
    command: pi.zod
      .union([pi.zod.string(), pi.zod.array(pi.zod.string())])
      .optional()
      .describe("Command/args overriding the image CMD (argv array preferred)"),
    name: pi.zod.string().optional().describe("Container name"),
    detach: pi.zod.boolean().optional().describe("Run detached (default true)"),
    rm: pi.zod.boolean().optional().describe("Remove the container when it exits (--rm)"),
    env: pi.zod.array(pi.zod.string()).optional().describe("Environment entries KEY=VALUE"),
    ports: pi.zod
      .array(pi.zod.string())
      .optional()
      .describe("Port mappings: '8080:80', '127.0.0.1:5432:5432', or '53:53/udp'"),
    volumes: pi.zod
      .array(pi.zod.string())
      .optional()
      .describe("Mounts: 'host/path:/container/path[:ro]', 'named_vol:/path', or '/container/path' for anonymous"),
    workdir: pi.zod.string().optional().describe("Working directory inside the container (-w)"),
    entrypoint: pi.zod.string().optional().describe("Override ENTRYPOINT (--entrypoint)"),
    network: pi.zod.string().optional().describe("Network to attach (--network)"),
    restart: pi.zod
      .enum(["no", "always", "unless-stopped", "on-failure"])
      .optional()
      .describe("Restart policy (--restart)"),
    labels: pi.zod.array(pi.zod.string()).optional().describe("Labels KEY=VALUE"),
    user: pi.zod.string().optional().describe("User or uid[:gid] (-u)"),
    memory: pi.zod.string().optional().describe("Memory limit, e.g. 512m or 2g (-m)"),
    cpus: pi.zod.string().optional().describe("CPU quota, e.g. 1.5 (--cpus)"),
    platform: pi.zod.string().optional().describe("Platform, e.g. linux/amd64 (--platform)"),
    pull: pi.zod
      .enum(["always", "missing", "never"])
      .optional()
      .describe("Image pull policy (--pull); default Docker behaviour is missing"),
    privileged: pi.zod.boolean().optional().describe("Run privileged (--privileged); use sparingly"),
    timeoutMs: pi.zod
      .number()
      .optional()
      .describe("Timeout in ms for non-detached runs (default 300000)"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const {
      image,
      command,
      name,
      detach = true,
      rm,
      env,
      ports,
      volumes,
      workdir,
      entrypoint,
      network,
      restart,
      labels,
      user,
      memory,
      cpus,
      platform,
      pull,
      privileged,
      timeoutMs,
    } = params;

    const envArgs = keyValueArgs("-e", env, "env");
    if (envArgs.error) return commandResult("docker run", { command: "", stdout: "", stderr: envArgs.error, code: 2, killed: false, timedOut: false });
    const labelArgs = keyValueArgs("--label", labels, "labels");
    if (labelArgs.error) return commandResult("docker run", { command: "", stdout: "", stderr: labelArgs.error, code: 2, killed: false, timedOut: false });

    for (const volume of volumes ?? []) {
      if (!volume.includes(":") && !volume.startsWith("/")) {
        return commandResult("docker run", {
          command: "",
          stdout: "",
          stderr: `volume ${JSON.stringify(volume)} must be 'src:dst', 'named_vol:/dst', or an absolute container path`,
          code: 2,
          killed: false,
          timedOut: false,
        });
      }
    }

    const args = ["run"];
    if (detach) args.push("--detach");
    if (rm) args.push("--rm");
    if (name) args.push("--name", name);
    for (const port of ports ?? []) args.push("--publish", port);
    for (const volume of volumes ?? []) args.push("--volume", volume);
    args.push(...envArgs.args, ...labelArgs.args);
    if (workdir) args.push("--workdir", workdir);
    if (entrypoint) args.push("--entrypoint", entrypoint);
    if (network) args.push("--network", network);
    if (restart) args.push("--restart", restart);
    if (user) args.push("--user", user);
    if (memory) args.push("--memory", memory);
    if (cpus) args.push("--cpus", cpus);
    if (platform) args.push("--platform", platform);
    if (pull) args.push("--pull", pull);
    if (privileged) args.push("--privileged");
    args.push(image);
    if (Array.isArray(command)) args.push(...command);
    else if (command) args.push(command);

    const res = await runDocker(pi.exec, args, {
      signal,
      cwd: pi.cwd,
      timeoutMs: timeoutMs ?? (detach ? 120_000 : 300_000),
    });

    if (res.code !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `docker run ${image} failed (exit ${res.code}${res.timedOut ? ", timed out" : ""}):\n${clamp(
              `${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`,
              8_000,
            )}`,
          },
        ],
        isError: true,
        details: { image, exitCode: res.code },
      };
    }

    if (detach) {
      const id = res.stdout.trim().split(/\r?\n/).pop() ?? "";
      return {
        content: [
          {
            type: "text",
            text: `Started ${image}${name ? ` as ${name}` : ""}: ${id.slice(0, 12)}\n\nNext: docker_ps to confirm state, docker_logs to follow startup.`,
          },
        ],
        details: { image, containerId: id, name },
      };
    }

    const body = clamp(`${res.stdout}${res.stderr ? `\n--- stderr ---\n${res.stderr}` : ""}`, 16_000);
    return {
      content: [
        {
          type: "text",
          text: `docker run ${image} exited 0${rm ? " (container removed)" : ""}\n${body || "(no output)"}`,
        },
      ],
      details: { image, exitCode: 0 },
    };
  },
});

export default factory;
