import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, fail, getPath, ok, runDocker, tryParseJson } from "./_docker";

/** Inspect Docker objects and pull specific fields out of the JSON. */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_inspect",
  label: "Docker Inspect",
  description:
    "Inspect containers, images, networks or volumes. Returns full JSON or, with `path`, just the requested field(s) " +
    "such as 'State.Status', 'NetworkSettings.Ports', 'Config.Env' or 'Mounts[0].Source'. " +
    "Use to answer concrete questions (why did it exit, which port is published, what image digest) without dumping huge JSON.",
  approval: "read",
  parameters: pi.zod.object({
    type: pi.zod
      .enum(["container", "image", "network", "volume"])
      .optional()
      .describe("Object type (default container)"),
    target: pi.zod.string().describe("Object name or ID"),
    path: pi.zod
      .string()
      .optional()
      .describe("Dot/bracket path into the JSON, e.g. 'State.ExitCode' or 'NetworkSettings.Ports'"),
    size: pi.zod.boolean().optional().describe("Include size info for containers (-s)"),
    maxChars: pi.zod.number().optional().describe("Output cap for full JSON (default 16000)"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const { type = "container", target, path, size, maxChars = 16_000 } = params;
    const args = ["inspect", "--type", type];
    if (size && type === "container") args.push("--size");
    args.push(target);

    const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 30_000 });
    if (res.code !== 0) {
      return fail(`docker inspect ${type} ${target} failed (exit ${res.code}):\n${clamp(res.stderr || res.stdout)}`);
    }

    const parsed = tryParseJson<unknown[]>(res.stdout);
    if (!parsed || !Array.isArray(parsed)) {
      return fail(`Could not parse docker inspect output:\n${clamp(res.stdout)}`);
    }
    const object = parsed[0];
    if (!path) {
      return ok(clamp(JSON.stringify(object, null, 2), maxChars), { type, target });
    }

    const value = getPath(object, path);
    if (value === undefined) {
      const keys = object && typeof object === "object" ? Object.keys(object as object) : [];
      return fail(
        `Path '${path}' not found on ${type} ${target}. Top-level keys: ${keys.join(", ") || "(none)"}`,
      );
    }
    const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return ok(clamp(rendered, maxChars), { type, target, path });
  },
});

export default factory;
