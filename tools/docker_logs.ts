import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { clamp, commandResult, runDocker } from "./_docker";

/** Container logs with tail/since/grep filtering. */
const factory: CustomToolFactory = (pi) => ({
  name: "docker_logs",
  label: "Docker Logs",
  description:
    "Read logs from a container (running or exited). Supports tail count, time windows (since/until), " +
    "timestamp prefixes, previous-boot logs, and client-side regex filtering. " +
    "Use after docker_ps to diagnose crashes, config errors or request failures.",
  approval: "read",
  parameters: pi.zod.object({
    container: pi.zod.string().describe("Container name or ID"),
    tail: pi.zod
      .number()
      .optional()
      .describe("Number of trailing lines (default 200; use 0 with since for the whole window)"),
    since: pi.zod
      .string()
      .optional()
      .describe("Start time: RFC3339, unix timestamp, or relative like 10m/2h/2026-10-24T10:00:00Z"),
    until: pi.zod.string().optional().describe("End time (same formats as since)"),
    timestamps: pi.zod.boolean().optional().describe("Prefix each line with its timestamp"),
    previous: pi.zod.boolean().optional().describe("Logs from the previous container instance"),
    grep: pi.zod.string().optional().describe("Client-side regex filter (case-insensitive)"),
    invertGrep: pi.zod.boolean().optional().describe("Keep only lines NOT matching grep"),
    maxLines: pi.zod.number().optional().describe("Hard cap on returned lines (default 400)"),
    maxChars: pi.zod.number().optional().describe("Hard cap on returned characters (default 16000)"),
  }),

  async execute(_id, params, _onUpdate, _ctx, signal) {
    const {
      container,
      tail = 200,
      since,
      until,
      timestamps,
      previous,
      grep,
      invertGrep,
      maxLines = 400,
      maxChars = 16_000,
    } = params;

    let regex: RegExp | undefined;
    if (grep) {
      try {
        regex = new RegExp(grep, "i");
      } catch (error) {
        return commandResult("docker logs", {
          command: "",
          stdout: "",
          stderr: `Invalid grep pattern: ${(error as Error).message}`,
          code: 2,
          killed: false,
          timedOut: false,
        });
      }
    }

    const args = ["logs", "--tail", String(tail)];
    if (timestamps) args.push("--timestamps");
    if (previous) args.push("--previous");
    if (since) args.push("--since", since);
    if (until) args.push("--until", until);
    args.push(container);

    const res = await runDocker(pi.exec, args, { signal, cwd: pi.cwd, timeoutMs: 60_000 });
    if (res.code !== 0) return commandResult(`docker logs ${container}`, res);

    // Docker writes container stdout to stdout and stderr to stderr; merge in stream order per stream.
    let lines = `${res.stdout}${res.stderr}`.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (regex) {
      lines = lines.filter((line) => regex!.test(line) !== Boolean(invertGrep));
    }
    const truncatedLines = lines.length > maxLines;
    if (truncatedLines) lines = lines.slice(-maxLines);

    const header = `${container}: ${lines.length} line(s)${
      truncatedLines ? ` (last ${maxLines} shown)` : ""
    }${regex ? ` matching /${grep}/${invertGrep ? "i (inverted)" : "i"}` : ""}`;
    const body = clamp(lines.join("\n"), maxChars, "tail");
    if (lines.length === 0) {
      return {
        content: [{ type: "text", text: `${header}\n(no log lines match)` }],
        details: { container, lineCount: 0 },
        useless: true,
      };
    }
    return {
      content: [{ type: "text", text: `${header}\n\n${body}` }],
      details: { container, lineCount: lines.length },
    };
  },
});

export default factory;
