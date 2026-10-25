import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, fail, ok, parseJsonLines, runDocker, table } from "./_docker";

interface DfRow {
  Type: string;
  TotalCount: string;
  Active: string;
  Size: string;
  Reclaimable: string;
}

/**
 * Disk usage inventory plus a plan/preview for reclaiming space.
 *
 * Cleanup is staged in two steps on purpose: `plan` reports what would be removed
 * (including dollar-free byte estimates) and `apply` performs it. Nothing is ever
 * pruned implicitly, and images referenced by a container are never in scope.
 */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_cleanup",
  label: "Docker Cleanup",
  description:
    "Report Docker disk usage and reclaim space. Actions: report (system df), plan (what would be reclaimed), apply (actually prune). " +
    "Scopes: build-cache, dangling-images, stopped-containers, unused-volumes, unused-networks, all. " +
    "`apply` requires confirm=true and refuses unused-volume pruning unless the scope explicitly names volumes, because data loss is irreversible. " +
    "Run `plan` first and show the user the numbers.",
  approval: (args) => {
    // The harness passes parsed params but the callback type is `unknown`.
    const action = typeof args === "object" && args !== null && "action" in args
      ? (args as { action?: string }).action
      : undefined;
    if (action !== "apply") return "read";
    return { tier: "write", reason: "Prunes Docker objects and deletes data" };
  },
  parameters: pi.zod.object({
    action: pi.zod.enum(["report", "plan", "apply"]).describe("report: usage only; plan: dry-run preview; apply: prune"),
    scopes: pi.zod
      .array(pi.zod.enum(["build-cache", "dangling-images", "stopped-containers", "unused-volumes", "unused-networks", "all"]))
      .optional()
      .describe("What to consider (default ['all']); 'all' includes volumes only when allowVolumes is set"),
    allowVolumes: pi.zod.boolean().optional().describe("Include unused-volumes when scope is 'all'"),
    keepImages: pi.zod.boolean().optional().describe("For plan: also list unused non-dangling images (not pruned by default)"),
    confirm: pi.zod.boolean().optional().describe("Required for apply"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const { action, scopes, allowVolumes, keepImages, confirm } = params;

    const dfRes = await runDocker(pi.exec, ["system", "df", "--format", "{{json .}}"], {
      signal,
      cwd: pi.cwd,
      timeoutMs: 60_000,
    });
    if (dfRes.code !== 0) return fail(`docker system df failed (exit ${dfRes.code}):\n${clamp(dfRes.stderr || dfRes.stdout)}`);
    const df = parseJsonLines<DfRow>(dfRes.stdout);

    if (action === "report") {
      return ok(
        table(
          ["TYPE", "TOTAL", "ACTIVE", "SIZE", "RECLAIMABLE"],
          df.map((row) => [row.Type, row.TotalCount, row.Active, row.Size, row.Reclaimable]),
        ),
        { usage: df },
      );
    }

    const requested = new Set(scopes && scopes.length > 0 ? scopes : ["all"]);
    const everything = requested.has("all");
    const includeVolumes = requested.has("unused-volumes") || (everything && allowVolumes === true);

    if (action === "plan") {
      const findings: string[] = [];
      const details: Record<string, unknown> = {};

      if (everything || requested.has("build-cache")) {
        const res = await runDocker(pi.exec, ["buildx", "du", "--verbose"], { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        const cacheLine = df.find((row) => row.Type === "Build Cache");
        findings.push(
          `build cache: ${cacheLine?.Size ?? "?"} total, ${cacheLine?.Reclaimable ?? "?"} reclaimable` +
            (res.code !== 0 ? " (docker buildx unavailable — prune still works)" : ""),
        );
        details.buildCache = cacheLine;
      }

      if (everything || requested.has("dangling-images")) {
        const res = await runDocker(
          pi.exec,
          ["images", "--filter", "dangling=true", "--format", "{{json .}}"],
          { signal, cwd: pi.cwd, timeoutMs: 60_000 },
        );
        const rows = parseJsonLines<{ ID: string; Size: string }>(res.stdout);
        if (rows.length > 0) {
          findings.push(`dangling images: ${rows.length}`);
          details.danglingImages = rows.map((row) => ({ id: row.ID.slice(0, 12), size: row.Size }));
        }
      }

      if (everything || requested.has("stopped-containers")) {
        const res = await runDocker(
          pi.exec,
          ["ps", "--all", "--filter", "status=exited", "--filter", "status=created", "--format", "{{json .}}"],
          { signal, cwd: pi.cwd, timeoutMs: 60_000 },
        );
        const rows = parseJsonLines<{ Names: string; Status: string; Image: string }>(res.stdout);
        if (rows.length > 0) {
          findings.push(`stopped containers: ${rows.length}`);
          details.stoppedContainers = rows.map((row) => ({ name: row.Names, status: row.Status, image: row.Image }));
        }
      }

      if (includeVolumes) {
        const res = await runDocker(
          pi.exec,
          ["volume", "ls", "--filter", "dangling=true", "--format", "{{json .}}"],
          { signal, cwd: pi.cwd, timeoutMs: 60_000 },
        );
        const rows = parseJsonLines<{ Name: string }>(res.stdout);
        if (rows.length > 0) {
          findings.push(`unused volumes: ${rows.length} (DATA LOSS if pruned)`);
          details.unusedVolumes = rows.map((row) => row.Name);
        }
      } else if (everything) {
        const res = await runDocker(
          pi.exec,
          ["volume", "ls", "--filter", "dangling=true", "--format", "{{.Name}}"],
          { signal, cwd: pi.cwd, timeoutMs: 60_000 },
        );
        const names = res.stdout.split(/\r?\n/).filter(Boolean);
        if (names.length > 0) {
          findings.push(
            `unused volumes: ${names.length} — NOT included by default (set allowVolumes=true to include; this deletes data)`,
          );
        }
      }

      if (everything || requested.has("unused-networks")) {
        findings.push("unused networks: run docker_network action='prune' dryRun=true to enumerate");
      }

      if (keepImages) {
        const res = await runDocker(pi.exec, ["images", "--format", "{{json .}}"], { signal, cwd: pi.cwd, timeoutMs: 60_000 });
        const rows = parseJsonLines<{ Repository: string; Tag: string; Size: string }>(res.stdout);
        details.images = rows.map((row) => `${row.Repository}:${row.Tag} (${row.Size})`);
      }

      return ok(
        [
          "Docker disk usage:",
          table(
            ["TYPE", "TOTAL", "ACTIVE", "SIZE", "RECLAIMABLE"],
            df.map((row) => [row.Type, row.TotalCount, row.Active, row.Size, row.Reclaimable]),
          ),
          "",
          findings.length > 0 ? `Would reclaim:\n${findings.map((line) => `- ${line}`).join("\n")}` : "Nothing to reclaim in the requested scopes.",
          "",
          "Re-run with action='apply', confirm=true to execute.",
        ].join("\n"),
        { plan: details },
      );
    }

    // action === "apply"
    if (!confirm) {
      return fail(
        "Refusing to prune without confirm=true. Run action='plan' first and show the user the reclaimable size.",
      );
    }

    const steps: Array<{ label: string; args: string[] }> = [];
    if (everything || requested.has("build-cache")) {
      steps.push({ label: "build cache", args: ["builder", "prune", "--force"] });
    }
    if (everything || requested.has("dangling-images")) {
      steps.push({ label: "dangling images", args: ["image", "prune", "--force"] });
    }
    if (everything || requested.has("stopped-containers")) {
      steps.push({ label: "stopped containers", args: ["container", "prune", "--force"] });
    }
    if (includeVolumes) {
      steps.push({ label: "unused volumes", args: ["volume", "prune", "--force"] });
    }
    if (everything || requested.has("unused-networks")) {
      steps.push({ label: "unused networks", args: ["network", "prune", "--force"] });
    }

    const lines: string[] = [];
    let failed = false;
    for (const step of steps) {
      const res = await runDocker(pi.exec, step.args, { signal, cwd: pi.cwd, timeoutMs: 300_000 });
      const body = clamp(`${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`, 4_000);
      lines.push(`## ${step.label} (exit ${res.code})\n${body || "(no output)"}`);
      if (res.code !== 0) failed = true;
    }

    const after = await runDocker(pi.exec, ["system", "df", "--format", "{{json .}}"], {
      signal,
      cwd: pi.cwd,
      timeoutMs: 60_000,
    });
    const afterRows = parseJsonLines<DfRow>(after.stdout);
    const summary = table(
      ["TYPE", "TOTAL", "ACTIVE", "SIZE", "RECLAIMABLE"],
      afterRows.map((row) => [row.Type, row.TotalCount, row.Active, row.Size, row.Reclaimable]),
    );
    const result = ok(`${lines.join("\n\n")}\n\n### After\n${summary}`, { steps: steps.map((s) => s.label) });
    return failed ? { ...result, isError: true } : result;
  },
});

export default factory;