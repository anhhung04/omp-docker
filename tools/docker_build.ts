import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, commandResult, keyValueArgs, runDocker } from "./_docker";

/**
 * Build an image from a Dockerfile.
 *
 * The context path is resolved against the session cwd; `dockerfile` is kept
 * separate so non-standard filenames (Dockerfile.dev, containers/api.Dockerfile)
 * work without changing the context.
 */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_build",
  label: "Docker Build",
  description:
    "Build a Docker image from a Dockerfile and tag it. Supports build args, target stage, platform, no-cache, labels and remote/cached contexts. " +
    "Build output is streamed to the result (tail kept on failure). Use after editing code or a Dockerfile; " +
    "for compose-defined builds use docker_compose action='build' so compose can resolve its own config.",
  approval: { tier: "exec", reason: "Builds an image, executing the Dockerfile" },
  parameters: pi.zod.object({
    context: pi.zod.string().optional().describe("Build context path (default '.')"),
    tag: pi.zod.array(pi.zod.string()).optional().describe("Image tags (-t), e.g. ['app:dev']"),
    dockerfile: pi.zod.string().optional().describe("Dockerfile path relative to context (-f)"),
    buildArgs: pi.zod.array(pi.zod.string()).optional().describe("Build args KEY=VALUE"),
    target: pi.zod.string().optional().describe("Multi-stage target (--target)"),
    platform: pi.zod.string().optional().describe("Target platform, e.g. linux/amd64 (--platform)"),
    noCache: pi.zod.boolean().optional().describe("Ignore layer cache (--no-cache)"),
    labels: pi.zod.array(pi.zod.string()).optional().describe("Image labels KEY=VALUE"),
    pull: pi.zod.boolean().optional().describe("Always pull newer base images (--pull)"),
    progress: pi.zod.enum(["auto", "plain", "tty"]).optional().describe("Build output mode (--progress)"),
    timeoutMs: pi.zod.number().optional().describe("Timeout in ms (default 900000)"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const {
      context = ".",
      tag,
      dockerfile,
      buildArgs,
      target,
      platform,
      noCache,
      labels,
      pull,
      progress,
      timeoutMs,
    } = params;

    const argArgs = keyValueArgs("--build-arg", buildArgs, "buildArgs");
    if (argArgs.error) return commandResult("docker build", { command: "", stdout: "", stderr: argArgs.error, code: 2, killed: false, timedOut: false });
    const labelArgs = keyValueArgs("--label", labels, "labels");
    if (labelArgs.error) return commandResult("docker build", { command: "", stdout: "", stderr: labelArgs.error, code: 2, killed: false, timedOut: false });

    const args = ["build"];
    for (const value of tag ?? []) args.push("--tag", value);
    if (dockerfile) args.push("--file", dockerfile);
    args.push(...argArgs.args, ...labelArgs.args);
    if (target) args.push("--target", target);
    if (platform) args.push("--platform", platform);
    if (noCache) args.push("--no-cache");
    if (pull) args.push("--pull");
    if (progress) args.push("--progress", progress);
    args.push(context);

    const res = await runDocker(pi.exec, args, {
      signal,
      cwd: pi.cwd,
      timeoutMs: timeoutMs ?? 900_000,
    });
    return commandResult("docker build", res, { maxChars: 16_000, mode: res.code === 0 ? "tail" : "middle" });
  },
});

export default factory;