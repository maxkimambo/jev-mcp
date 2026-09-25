/**
 * pi extension: the jev tools as native pi tools, plus `/jev on|off|status`.
 *
 * pi has no MCP client by design, so on session start this runs the bundled jev
 * server and registers each of its tools with pi, forwarding calls over stdio.
 * The switch and ledger are the ones Claude Code's plugin uses, so `/jev on` in
 * either agent turns the tools on for both.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The parts of pi's ExtensionAPI this uses, so the extension builds without pi installed. */
interface ExtensionContext {
  ui: { notify(message: string, level: "info" | "warning" | "error"): void };
}
interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}
interface ExtensionAPI {
  on(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: ExtensionContext) => Promise<void>): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  }): void;
  registerCommand(name: string, options: { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> }): void;
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

// Both the build (dist/) and the bundle (bundle/) sit one level below the package root.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const JEV_HOME = () => process.env.JEV_HOME ?? join(homedir(), ".claude", "jev-think");
/** A page ranking fetches and judges up to 20 pages; the SDK's 60 s default is too tight. */
const CALL_TIMEOUT_MS = 120_000;

export default function jev(pi: ExtensionAPI) {
  let client: Client | undefined;

  pi.on("session_start", async () => {
    const home = JEV_HOME();
    client = new Client({ name: "pi", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(ROOT, "bundle", "index.js")],
        env: { ...(process.env as Record<string, string>), JEV_SWITCH_FILE: join(home, "state.json"), JEV_LEDGER: join(home, "ledger.jsonl") },
        stderr: "ignore",
      }),
    );
    const connected = client;
    for (const tool of (await connected.listTools()).tools) {
      pi.registerTool({
        name: tool.name,
        label: tool.title ?? tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
        async execute(_toolCallId, params, signal) {
          const result = await connected.callTool({ name: tool.name, arguments: params }, undefined, { signal, timeout: CALL_TIMEOUT_MS });
          const text = (result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
          // pi marks a tool call as failed only when execute throws.
          if (result.isError) throw new Error(text);
          return { content: [{ type: "text", text }], details: result.structuredContent ?? {} };
        },
      });
    }
  });

  pi.on("session_shutdown", async () => {
    await client?.close();
    client = undefined;
  });

  pi.registerCommand("jev", {
    description: "Turn the jev tools on or off, or show calls and cost: /jev on | off | status",
    async handler(args, ctx) {
      const { stdout, stderr } = await pi.exec(process.execPath, [join(ROOT, "bundle", "cli.js"), ...args.split(/\s+/).filter(Boolean)]);
      ctx.ui.notify((stdout || stderr).trim(), "info");
    },
  });
}
