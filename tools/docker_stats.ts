import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, fail, ok, parseJsonLines, runDocker, table } from "./_docker";

interface StatsRow {
  Container: string;
  Name: string;
  CPUPerc: string;
  MemUsage: string;
  MemPerc: string;
  NetIO: string;
  BlockIO: string;
  PIDs: string;
}

/** Point-in-time resource usage for containers. */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_stats",
  label: "Docker Stats",
  description:
    "Snapshot CPU, memory, network, block I/O and PID counts for containers (one-shot, not streaming). " +
    "Use to confirm a service is actually under load, find a memory hog, or check whether a container is idle before blaming it. " +
    "For historical resource data use `docker events`/cAdvisor; this is instantaneous.",
  approval: "read",
  parameters: pi.zod.object({
    containers: pi.zod
      .array(pi.zod.string())
      .optional()
      .describe("Specific container names/IDs (default: all running)"),
    all: pi.zod.boolean().optional().describe("Include stopped containers (-a)"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const { containers, all } = params;
    const args = ["stats", "--no-stream", "--format", "{{json .}}"];
    if (all) args.push("--all");
    if (containers && containers.length > 0) args.push(...containers);

    const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 60_000 });
    if (res.code !== 0) {
      return fail(`docker stats failed (exit ${res.code}):\n${clamp(res.stderr || res.stdout)}`);
    }

    const rows = parseJsonLines<StatsRow>(res.stdout);
    if (rows.length === 0) return ok("No containers to report (nothing running?).", { count: 0 });

    const body = table(
      ["NAME", "CPU%", "MEM USAGE", "MEM%", "NET I/O", "BLOCK I/O", "PIDS"],
      rows.map((row) => [row.Name, row.CPUPerc, row.MemUsage, row.MemPerc, row.NetIO, row.BlockIO, row.PIDs]),
    );
    return ok(body, {
      stats: rows.map((row) => ({
        name: row.Name,
        id: row.Container,
        cpuPercent: row.CPUPerc,
        memUsage: row.MemUsage,
        memPercent: row.MemPerc,
        netIo: row.NetIO,
        blockIo: row.BlockIO,
        pids: row.PIDs,
      })),
    });
  },
});

export default factory;
