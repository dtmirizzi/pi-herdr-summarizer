/**
 * Herdr Workspace Summarizer
 *
 * Auto-names herdr workspaces using AI one-word summaries. Reads the pi
 * session file to understand what the user is working on, then asks an LLM
 * for a single descriptive word. Supports OpenRouter, Anthropic, or OpenAI
 * API keys from environment variables, or pi's configured models.
 *
 * Commands:
 *   /herdr-summarize     - Summarize all workspaces
 *
 * Tools:
 *   summarize_workspaces - LLM-callable tool for workspace summary
 *
 * Environment variables (in order of preference):
 *   OPENROUTER_API_KEY   - OpenRouter API key
 *   ANTHROPIC_API_KEY    - Anthropic API key
 *   OPENAI_API_KEY       - OpenAI API key
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import net from "node:net";
import { execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HerdrWorkspace {
  id: string;
  label: string;
  cwd: string;
  sessionPath?: string;
}

interface SnapshotEntry {
  result: {
    snapshot: {
      workspaces: Array<{ workspace_id: string; label: string }>;
      panes: Array<{
        workspace_id: string;
        foreground_cwd: string;
        agent_session?: {
          agent: string;
          kind: string;
          value: string;
        };
      }>;
    };
  };
}

// ---------------------------------------------------------------------------
// Herdr socket helpers
// ---------------------------------------------------------------------------

function getHerdrSocketPath(): string {
  return (
    process.env.HERDR_SOCKET_PATH ||
    path.join(os.homedir(), ".config", "herdr", "herdr.sock")
  );
}

function sendSocketRequest(
  socketPath: string,
  request: object,
  timeoutMs = 3000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = "";
    let timeout: ReturnType<typeof setTimeout>;

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    socket.on("end", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    socket.on("error", reject);
    timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Socket timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------

function getWorkspaces(): HerdrWorkspace[] {
  const raw = execSync("herdr api snapshot", {
    encoding: "utf8",
    timeout: 5000,
  });

  const snapshot = JSON.parse(raw) as SnapshotEntry;
  const { workspaces, panes } = snapshot.result.snapshot;

  return workspaces.map((w) => {
    const pane = panes.find((p) => p.workspace_id === w.workspace_id);
    const cwd = pane?.foreground_cwd ?? os.homedir();

    // Extract pi session path if available
    let sessionPath: string | undefined;
    const ag = pane?.agent_session;
    if (ag?.agent === "pi" && ag?.kind === "path") {
      sessionPath = ag.value;
    }

    return { id: w.workspace_id, label: w.label, cwd, sessionPath };
  });
}

// ---------------------------------------------------------------------------
// Session reading
// ---------------------------------------------------------------------------

async function readFirstUserMessage(
  sessionPath: string,
): Promise<string | undefined> {
  try {
    const stream = fs.createReadStream(sessionPath, "utf8");
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: { type?: string; message?: { role?: string; content?: unknown } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type === "message" && entry.message?.role === "user") {
        const content = entry.message.content;
        if (typeof content === "string") return content.slice(0, 300);
        if (Array.isArray(content)) {
          const texts = content
            .filter(
              (c): c is { type: "text"; text: string } =>
                typeof c === "object" && c !== null && c.type === "text",
            )
            .map((c) => c.text);
          if (texts.length > 0) return texts.join(" ").slice(0, 300);
        }
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Context gathering
// ---------------------------------------------------------------------------

function gatherProjectContext(cwd: string): string {
  const parts: string[] = [];

  // package.json
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.name) parts.push(`npm:${pkg.name}`);
      if (pkg.description) parts.push(pkg.description);
    } catch { /* ignore */ }
  }

  // Cargo.toml
  const cargoPath = path.join(cwd, "Cargo.toml");
  if (fs.existsSync(cargoPath)) {
    try {
      const m = fs.readFileSync(cargoPath, "utf8").match(/^name\s*=\s*"(.+?)"/m);
      if (m) parts.push(`rust:${m[1]}`);
    } catch { /* ignore */ }
  }

  // go.mod
  const goModPath = path.join(cwd, "go.mod");
  if (fs.existsSync(goModPath)) {
    try {
      const m = fs.readFileSync(goModPath, "utf8").match(/^module\s+(.+)$/m);
      if (m) parts.push(`go:${m[1]}`);
    } catch { /* ignore */ }
  }

  // pyproject.toml
  const ppPath = path.join(cwd, "pyproject.toml");
  if (fs.existsSync(ppPath)) {
    try {
      const m = fs.readFileSync(ppPath, "utf8").match(/^name\s*=\s*"(.+?)"/m);
      if (m) parts.push(`py:${m[1]}`);
    } catch { /* ignore */ }
  }

  // README heading
  const readmePath = path.join(cwd, "README.md");
  if (fs.existsSync(readmePath)) {
    try {
      const m = fs.readFileSync(readmePath, "utf8").match(/^#\s+(.+)$/m);
      if (m) parts.push(m[1]);
    } catch { /* ignore */ }
  }

  return parts.join(" | ");
}

function buildContext(
  cwd: string,
  firstUserMessage?: string,
): string {
  const lines: string[] = [];

  // Primary: what the user is working on (from pi session)
  if (firstUserMessage) {
    lines.push(`Current task: ${firstUserMessage}`);
    lines.push(`Directory: ${path.basename(cwd)}`);
  } else {
    lines.push(`Directory: ${path.basename(cwd)}`);
    const project = gatherProjectContext(cwd);
    if (project) lines.push(`Project: ${project}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(context: string): string {
  return [
    "Name this workspace with a short, descriptive label (1-3 words, 50 chars max).",
    "Capture what the person is working on. Reply with only the label, nothing else.",
    "",
    `Context: ${context}`,
    "",
    "Label:",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// LLM calls
// ---------------------------------------------------------------------------

async function callOpenRouter(context: string, apiKey: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/herdr-workspace-summarizer",
      "X-Title": "Herdr Workspace Summarizer",
    },
    body: JSON.stringify({
      model: "openai/gpt-4.1-nano",
      messages: [{ role: "user", content: buildPrompt(context) }],
      max_tokens: 20,
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter: ${res.status}`);
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content ?? "unknown";
}

async function callAnthropic(context: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-latest",
      max_tokens: 20,
      temperature: 0.3,
      messages: [{ role: "user", content: buildPrompt(context) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic: ${res.status}`);
  const data = (await res.json()) as {
    content: Array<{ text: string }>;
  };
  return data.content[0]?.text ?? "unknown";
}

async function callOpenAI(context: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: buildPrompt(context) }],
      max_tokens: 20,
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI: ${res.status}`);
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content ?? "unknown";
}

async function callPiModel(
  context: string,
  ctx: ExtensionContext,
): Promise<string> {
  const { complete, getModel } = await import("@earendil-works/pi-ai/compat");

  const candidates = [
    { provider: "openrouter", model: "openai/gpt-4.1-nano" },
    { provider: "openrouter", model: "anthropic/claude-3.5-haiku" },
    { provider: "openrouter", model: "google/gemini-2.0-flash-001" },
    { provider: "anthropic", model: "claude-3-5-haiku-latest" },
    { provider: "openai", model: "gpt-4.1-nano" },
    { provider: "openai", model: "gpt-4o-mini" },
  ];

  for (const { provider, model: modelId } of candidates) {
    const model = getModel(provider, modelId);
    if (!model) continue;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth?.ok || !auth.apiKey) continue;

    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: buildPrompt(context) }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers ?? {},
        env: auth.env,
      },
    );

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (text) return text;
  }

  throw new Error("No pi model available with valid API key");
}

// ---------------------------------------------------------------------------
// Word cleaning
// ---------------------------------------------------------------------------

function cleanName(raw: string, fallback: string): string {
  // Strip common LLM chatter, take first line
  const trimmed = raw.trim().split("\n")[0].trim();

  // Remove quotes, trailing punctuation, leading "Label:" etc
  let cleaned = trimmed
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/[.,;:!]+$/g, "")
    .replace(/^(label|name|the workspace is|this is)[:\s]+/i, "")
    .trim();

  // Allow spaces and hyphens, remove other odd chars
  cleaned = cleaned.replace(/[^\w\s-]/g, "").replace(/\s+/g, " ").trim();

  if (cleaned.length >= 1 && cleaned.length <= 50) return cleaned;
  if (cleaned.length > 50) return cleaned.slice(0, 50).replace(/\s+\S*$/, "");

  return fallback.slice(0, 50);
}

// ---------------------------------------------------------------------------
// Main summarizer
// ---------------------------------------------------------------------------

async function summarizeWorkspace(
  ws: HerdrWorkspace,
  ctx: ExtensionContext,
): Promise<string> {
  // Read pi session for context about what the user is working on
  let firstUserMessage: string | undefined;
  if (ws.sessionPath) {
    firstUserMessage = await readFirstUserMessage(ws.sessionPath);
  }

  const context = buildContext(ws.cwd, firstUserMessage);

  // 1. Try pi's configured models (via ctx)
  try {
    return cleanName(await callPiModel(context, ctx), path.basename(ws.cwd));
  } catch {
    /* fall through */
  }

  // 2. Try OpenRouter env var
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    try {
      return cleanName(await callOpenRouter(context, orKey), path.basename(ws.cwd));
    } catch {
      /* fall through */
    }
  }

  // 3. Try Anthropic env var
  const anthKey = process.env.ANTHROPIC_API_KEY;
  if (anthKey) {
    try {
      return cleanName(await callAnthropic(context, anthKey), path.basename(ws.cwd));
    } catch {
      /* fall through */
    }
  }

  // 4. Try OpenAI env var
  const oaiKey = process.env.OPENAI_API_KEY;
  if (oaiKey) {
    try {
      return cleanName(await callOpenAI(context, oaiKey), path.basename(ws.cwd));
    } catch {
      /* fall through */
    }
  }

  // 5. Fallback: use session-derived name or directory name
  if (firstUserMessage) {
    const words = firstUserMessage.split(/\s+/).slice(0, 5);
    return words.join(" ").replace(/[^\w\s-]/g, "").slice(0, 50) || path.basename(ws.cwd).replace(/^\./, "").slice(0, 50);
  }
  return path.basename(ws.cwd).replace(/^\./, "").slice(0, 50);
}

async function renameWorkspace(
  socketPath: string,
  workspaceId: string,
  label: string,
): Promise<void> {
  const id = `summarizer:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  await sendSocketRequest(socketPath, {
    id,
    method: "workspace.rename",
    params: { workspace_id: workspaceId, label },
  });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerCommand("herdr-summarize", {
    description:
      "Auto-name all herdr workspaces using AI (one-word summary per workspace)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify?.("Herdr summarizer requires a UI context", "warning");
        return;
      }

      let workspaces: HerdrWorkspace[];
      try {
        workspaces = getWorkspaces();
      } catch (err) {
        ctx.ui.notify(
          `Failed to read herdr workspaces. Is herdr running?\n${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return;
      }

      if (workspaces.length === 0) {
        ctx.ui.notify("No herdr workspaces found.", "info");
        return;
      }

      const socketPath = getHerdrSocketPath();

      for (const ws of workspaces) {
        try {
          ctx.ui.setStatus(
            "herdr-summarizer",
            `Naming ${ws.id}: ${ws.cwd}...`,
          );

          const name = await summarizeWorkspace(ws, ctx);
          await renameWorkspace(socketPath, ws.id, name);
          ctx.ui.setStatus("herdr-summarizer", "");
          ctx.ui.notify(`${ws.id} → "${name}"`, "success");
        } catch (err) {
          ctx.ui.setStatus("herdr-summarizer", "");
          ctx.ui.notify(
            `${ws.id}: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
      }

      ctx.ui.notify("Done!", "success");
    },
  });

  pi.registerTool({
    name: "summarize_workspaces",
    label: "Summarize Workspaces",
    description:
      "Auto-name all herdr workspaces using AI one-word summaries based on each workspace's project directory. Requires that herdr is running.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      let workspaces: HerdrWorkspace[];
      try {
        workspaces = getWorkspaces();
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to read herdr workspaces: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      if (workspaces.length === 0) {
        return { content: [{ type: "text", text: "No herdr workspaces found." }] };
      }

      const socketPath = getHerdrSocketPath();
      const results: string[] = [];

      for (const ws of workspaces) {
        try {
          const name = await summarizeWorkspace(ws, ctx);
          await renameWorkspace(socketPath, ws.id, name);
          results.push(`✓ ${ws.id}: "${ws.label}" → "${name}"`);
        } catch (err) {
          results.push(
            `✗ ${ws.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Herdr workspace summaries:\n${results.map((r) => `  ${r}`).join("\n")}`,
          },
        ],
        details: { results },
      };
    },
  });

  // Startup notification
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (!fs.existsSync(getHerdrSocketPath())) return;
    ctx.ui.notify(
      "Herdr summarizer ready — use /herdr-summarize to auto-name workspaces",
      "info",
    );
  });
}