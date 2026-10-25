import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, fail, ok, parseJsonLines, runDocker, table } from "./_docker";

interface PsRow {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Ports: string;
  RunningFor: string;
  Networks?: string;
  Labels?: string;
  LocalVolumes?: string;
  Size?: string;
}

/** List containers. */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_ps",
  label: "Docker Containers",
  description:
    "List Docker containers with state, status, ports, networks and sizes. " +
    "Use first when you need to know what is running, what exited, or which name/ID to target with docker_logs, docker_exec, docker_inspect. " +
    "Read-only: does not start or stop anything.",
  approval: "read",
  parameters: pi.zod.object({
    all: pi.zod.boolean().optional().describe("Include stopped containers (default true)"),
    status: pi.zod
      .enum(["created", "restarting", "running", "removing", "paused", "exited", "dead"])
      .optional()
      .describe("Only containers in this state"),
    name: pi.zod.string().optional().describe("Filter by container name (substring match)"),
    image: pi.zod.string().optional().describe("Filter by ancestor image"),
    label: pi.zod.string().optional().describe("Filter by label, KEY or KEY=VALUE"),
    grep: pi.zod.string().optional().describe("Client-side regex over name, image and ports"),
    limit: pi.zod.number().optional().describe("Maximum rows to return (default 50)"),
    size: pi.zod.boolean().optional().describe("Include container filesystem size (-s)"),
    json: pi.zod.boolean().optional().describe("Return raw JSON rows instead of a table"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const { all = true, status, name, image, label, grep, limit = 50, size, json } = params;
    const args = ["ps", "--format", "{{json .}}", "--no-trunc"];
    if (all) args.push("--all");
    if (size) args.push("--size");
    if (status) args.push("--filter", `status=${status}`);
    if (name) args.push("--filter", `name=${name}`);
    if (image) args.push("--filter", `ancestor=${image}`);
    if (label) args.push("--filter", `label=${label}`);

    const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 30_000 });
    if (res.code !== 0) {
      return fail(`docker ps failed (exit ${res.code}):\n${clamp(res.stderr || res.stdout)}`);
    }

    let rows = parseJsonLines<PsRow>(res.stdout);
    if (grep) {
      let regex: RegExp;
      try {
        regex = new RegExp(grep, "i");
      } catch (error) {
        return fail(`Invalid grep pattern: ${(error as Error).message}`);
      }
      rows = rows.filter((row) =>
        regex.test(`${row.Names} ${row.Image} ${row.Ports} ${row.Status}`),
      );
    }

    if (rows.length === 0) {
      return ok("No containers match the given filters.", { count: 0, filters: params });
    }

    const total = rows.length;
    if (json) {
      return ok(clamp(JSON.stringify(rows.slice(0, limit), null, 2)), { count: total });
    }

    const body = table(
      ["NAME", "STATE", "STATUS", "IMAGE", "PORTS", "ID"],
      rows.slice(0, limit).map((row) => [
        row.Names,
        row.State,
        row.Status,
        row.Image,
        row.Ports || "-",
        row.ID.slice(0, 12),
      ]),
      { maxColumnWidth: 40 },
    );
    const suffix =
      total > limit ? `\n\n... ${total - limit} more containers not shown (raise limit).` : "";
    return ok(`${total} container(s)\n\n${body}${suffix}`, {
      count: total,
      containers: rows.map((row) => ({
        id: row.ID,
        name: row.Names,
        state: row.State,
        image: row.Image,
        status: row.Status,
        ports: row.Ports,
      })),
    });
  },
});

export default factory;
