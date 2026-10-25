import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { commandResult, runDocker } from "./_docker";

/**
 * Copy files between the host and containers.
 *
 * One side must be a container reference (`name:/path`). Local paths are resolved
 * against the agent cwd, so relative paths behave like every other tool.
 */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_cp",
  label: "Docker Copy",
  description:
    "Copy files/directories between the host and a container. Reference a container side as 'container:/path'; " +
    "the other side is a host path (relative paths resolve against the session cwd). " +
    "Use to pull a config file or DB dump out for inspection, or to push a patched file in.",
  approval: { tier: "write", reason: "Writes files on the host or inside a container" },
  parameters: pi.zod.object({
    source: pi.zod.string().describe("Source path: 'container:/path' or a host path"),
    destination: pi.zod.string().describe("Destination path: 'container:/path' or a host path"),
    archive: pi.zod.boolean().optional().describe("Preserve uid/gid and permissions (-a)"),
    followLink: pi.zod.boolean().optional().describe("Follow symlinks in the source (-L)"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const { source, destination, archive, followLink } = params;
    const isContainerRef = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]*:\//.test(value);
    if (!isContainerRef(source) && !isContainerRef(destination)) {
      return commandResult("docker cp", {
        command: "",
        stdout: "",
        stderr: "At least one of source/destination must be a container reference like 'app:/etc/nginx/nginx.conf'",
        code: 2,
        killed: false,
        timedOut: false,
      });
    }

    const args = ["cp"];
    if (archive) args.push("--archive");
    if (followLink) args.push("--follow-link");
    args.push(source, destination);

    const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 120_000 });
    return commandResult(`docker cp ${source} -> ${destination}`, res);
  },
});

export default factory;
