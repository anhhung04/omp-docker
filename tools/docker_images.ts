import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, fail, ok, parseJsonLines, runDocker, table } from "./_docker";

interface ImageRow {
  ID: string;
  Repository: string;
  Tag: string;
  Digest: string;
  CreatedSince: string;
  Size: string;
  Containers?: string;
}

/** List local images. */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_images",
  label: "Docker Images",
  description:
    "List local Docker images with repository:tag, image ID, age, size and container count. " +
    "Filter by reference, dangling status or label. Use before docker_run/docker_build to check whether the image " +
    "already exists locally, and to find stale tags worth removing.",
  approval: "read",
  parameters: pi.zod.object({
    reference: pi.zod.string().optional().describe("Filter by repository[:tag] reference"),
    dangling: pi.zod.boolean().optional().describe("Only dangling (untagged) images"),
    all: pi.zod.boolean().optional().describe("Include intermediate images (-a)"),
    label: pi.zod.string().optional().describe("Filter by label KEY or KEY=VALUE"),
    limit: pi.zod.number().optional().describe("Maximum rows (default 60)"),
    json: pi.zod.boolean().optional().describe("Return raw JSON rows"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const { reference, dangling, all, label, limit = 60, json } = params;
    const args = ["images", "--format", "{{json .}}", "--no-trunc"];
    if (all) args.push("--all");
    if (reference) args.push(reference);
    if (dangling) args.push("--filter", "dangling=true");
    if (label) args.push("--filter", `label=${label}`);

    const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 30_000 });
    if (res.code !== 0) {
      return fail(`docker images failed (exit ${res.code}):\n${clamp(res.stderr || res.stdout)}`);
    }

    const rows = parseJsonLines<ImageRow>(res.stdout);
    if (rows.length === 0) return ok("No images match the given filters.", { count: 0 });
    if (json) return ok(clamp(JSON.stringify(rows.slice(0, limit), null, 2)), { count: rows.length });

    const body = table(
      ["REPOSITORY", "TAG", "IMAGE ID", "CREATED", "SIZE"],
      rows.slice(0, limit).map((row) => [
        row.Repository,
        row.Tag,
        row.ID.replace(/^sha256:/, "").slice(0, 12),
        row.CreatedSince,
        row.Size,
      ]),
      { maxColumnWidth: 44 },
    );
    const suffix = rows.length > limit ? `\n\n... ${rows.length - limit} more images not shown (raise limit).` : "";
    return ok(`${rows.length} image(s)\n\n${body}${suffix}`, {
      count: rows.length,
      images: rows.map((row) => ({
        id: row.ID,
        repository: row.Repository,
        tag: row.Tag,
        digest: row.Digest,
        size: row.Size,
        created: row.CreatedSince,
      })),
    });
  },
});

export default factory;
