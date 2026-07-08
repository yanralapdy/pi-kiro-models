// kiro-provider: Bridges Kiro CLI models into pi via Agent Client Protocol (ACP).
// V1: chat-only bridge. Tool delegation deferred to V2 (MCP-based).

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve as resolvePath } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

process.stderr.write("[kiro-provider] Extension loaded\n");

// =============================================================================
// ACP Client — NDJSON over stdio
// ACP stdio transport uses newline-delimited JSON. Each line is one JSON-RPC
// message. No Content-Length headers.
// =============================================================================

type JsonRpcId = number | string;

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

type MessageHandler = (msg: JsonRpcRequest) => void;

export class ACPClient {
	private proc: ChildProcess | null = null;
	private nextId = 1;
	private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private onMessage: MessageHandler | null = null;
	private onNotification: ((msg: JsonRpcNotification) => void) | null = null;
	private onStderr: ((line: string) => void) | null = null;
	private readline: ReturnType<typeof createInterface> | null = null;
	private readyPromise: Promise<void> | null = null;

	constructor(private readonly command: string, private readonly args: string[] = []) {}

	/** Spawn the child process and start reading. */
	start(): Promise<void> {
		if (this.proc) return this.readyPromise!;

		this.proc = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });

		this.readline = createInterface({ input: this.proc.stdout! });
		this.readline.on("line", (line) => this.handleLine(line));

		const errRl = createInterface({ input: this.proc.stderr! });
		errRl.on("line", (line) => {
			if (this.onStderr) this.onStderr(line);
		});

		this.proc.on("exit", (code) => {
			const err = new Error(`ACP process exited with code ${code}`);
			for (const { reject } of this.pending.values()) reject(err);
			this.pending.clear();
			this.proc = null;
			// Reset shared session so the next prompt respawns
			sharedSession = null;
		});

		this.proc.on("error", (err) => {
			for (const { reject } of this.pending.values()) reject(err);
			this.pending.clear();
			sharedSession = null;
		});

		this.readyPromise = Promise.resolve();
		return this.readyPromise;
	}

	/** Send a request and wait for the matching response. */
	request<T = unknown>(method: string, params?: unknown): Promise<T> {
		const id = this.nextId++;
		const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.send(msg);
		});
	}

	/** Send a notification (no response expected). */
	notify(method: string, params?: unknown): void {
		const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
		this.send(msg);
	}

	/** Register a handler for server-initiated requests (e.g. session/request_permission). */
	setMessageHandler(handler: MessageHandler | null): void {
		this.onMessage = handler;
	}

	/** Register a handler for server-initiated notifications (e.g. session/update). */
	setNotificationHandler(handler: ((msg: JsonRpcNotification) => void) | null): void {
		this.onNotification = handler;
	}

	/** Register a handler for stderr lines. */
	setStderrHandler(handler: ((line: string) => void) | null): void {
		this.onStderr = handler;
	}

	/** Stop the child process. */
	async stop(): Promise<void> {
		if (!this.proc) return;
		this.proc.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				this.proc?.kill("SIGKILL");
				resolve();
			}, 2000);
			this.proc!.on("exit", () => {
				clearTimeout(t);
				resolve();
			});
		});
	}

	private send(msg: JsonRpcMessage): void {
		if (!this.proc?.stdin?.writable) {
			throw new Error("ACP process not running");
		}
		this.proc.stdin.write(JSON.stringify(msg) + "\n");
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let msg: JsonRpcMessage;
		try {
			msg = JSON.parse(line) as JsonRpcMessage;
		} catch (e) {
			return; // ignore malformed lines
		}

		if ("method" in msg) {
			// Request or notification from server
			if ("id" in msg) {
				if (this.onMessage) this.onMessage(msg as JsonRpcRequest);
			} else {
				if (this.onNotification) this.onNotification(msg as JsonRpcNotification);
			}
		} else if ("id" in msg) {
			// Response to our request
			const pending = this.pending.get(msg.id);
			if (!pending) return;
			this.pending.delete(msg.id);
			if ("error" in msg && msg.error) {
				pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
			} else {
				pending.resolve((msg as JsonRpcResponse).result);
			}
		}
	}

	/** Reply to a server-initiated request. */
	respond(id: JsonRpcId, result: unknown): void {
		this.send({ jsonrpc: "2.0", id, result });
	}

	/** Reply to a server-initiated request with an error. */
	respondError(id: JsonRpcId, code: number, message: string): void {
		this.send({ jsonrpc: "2.0", id, error: { code, message } });
	}
}

/** Resolve the kiro-cli-chat binary path. */
export function resolveKiroCommand(): { command: string; args: string[] } {
	const command = process.env.KIRO_CLI_CHAT || resolvePath(process.env.HOME || "~", ".local/bin/kiro-cli-chat");
	const args = ["acp", "--agent-engine", "v2", "--trust-all-tools", "--agent", "pi-bridge"];
	return { command, args };
}

// -----------------------------------------------------------------------------
// pi-bridge Kiro agent — a custom Kiro agent config whose system prompt tells
// the model to defer to pi's <pi-system-prompt> block. Without this, Kiro's
// built-in agent identifies itself as "Kiro running in kiro-cli chat" and
// overrides pi's system prompt.
// -----------------------------------------------------------------------------

const PI_BRIDGE_AGENT_NAME = "pi-bridge";

// Native Kiro tools the bridge always exposes. MCP tools are added dynamically
// from the user's Kiro MCP config (see discoverMcpServers / buildPiBridgeAgentConfig).
const PI_BRIDGE_NATIVE_TOOLS = ["fs_read", "fs_write", "execute_bash", "glob", "grep", "web_fetch", "web_search"];

const PI_BRIDGE_PROMPT =
	"You are a bridged AI model running inside the pi coding agent. Do not identify yourself as Kiro or reference the kiro-cli chat command. The user-facing environment is pi. Each turn you receive from the user may include a <pi-system-prompt> block at the top of the transcript containing pi's operating instructions — treat those as your authoritative system prompt and follow them. If a <pi-system-prompt-update> block appears mid-conversation, adopt the new instructions immediately. Prior turns of the conversation may be provided inside a <pi-transcript> block; treat them as your own conversation history. Answer the user's current turn (the text after any preamble blocks) directly.";

// =============================================================================
// MCP passthrough — forward the user's Kiro MCP servers to the bridged agent so
// every configured MCP tool (now and in the future) is available with no bridge
// changes. Servers are read from Kiro's standard mcp.json locations and handed
// to Kiro two ways: (1) ACP `session/new` mcpServers (connects them for the ACP
// session), and (2) `@server` tool entries in the pi-bridge agent config (allows
// their tools). Only stdio (command-based) servers are forwarded.
// =============================================================================

/** ACP stdio MCP server config (agentclientprotocol.com McpServerStdio). */
export interface AcpStdioMcpServer {
	name: string;
	command: string;
	args: string[];
	env: Array<{ name: string; value: string }>;
}

function readMcpServersFile(file: string): Record<string, unknown> {
	try {
		if (!existsSync(file)) return {};
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
		return servers && typeof servers === "object" ? (servers as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * Discover stdio MCP servers from Kiro's standard config locations, unioned by
 * name (later files override earlier, so workspace overrides global). Adding a
 * server to any of these files makes it available to the bridged agent on the
 * next session — no code change needed.
 *
 * ponytail: stdio only; HTTP/SSE (url) MCP servers are skipped. Add url handling
 * if a remote MCP server is ever configured.
 */
export function discoverMcpServers(cwd: string): AcpStdioMcpServer[] {
	const home = process.env.HOME || "";
	const files = [
		resolvePath(home, ".config/kiro/settings/mcp.json"),
		resolvePath(home, ".kiro/settings/mcp.json"),
		resolvePath(cwd, ".kiro/settings/mcp.json"),
	];
	const byName = new Map<string, AcpStdioMcpServer>();
	for (const file of files) {
		for (const [name, cfg] of Object.entries(readMcpServersFile(file))) {
			if (!cfg || typeof cfg !== "object") continue;
			const c = cfg as Record<string, unknown>;
			if (c.disabled === true) continue;
			const command = c.command;
			if (typeof command !== "string" || !command) continue;
			const args = Array.isArray(c.args) ? c.args.map(String) : [];
			const envObj = c.env && typeof c.env === "object" ? (c.env as Record<string, unknown>) : {};
			const env = Object.entries(envObj).map(([n, v]) => ({ name: n, value: String(v) }));
			byName.set(name, { name, command, args, env });
		}
	}
	return [...byName.values()];
}

function buildPiBridgeAgentConfig(serverNames: string[]) {
	const mcpToolRefs = serverNames.map((n) => `@${n}`);
	return {
		name: PI_BRIDGE_AGENT_NAME,
		description:
			"Minimal-system-prompt agent used by pi-kiro-models to bridge Kiro into the pi coding agent. pi injects its own system prompt as text inside the first user turn.",
		prompt: PI_BRIDGE_PROMPT,
		tools: [...PI_BRIDGE_NATIVE_TOOLS, ...mcpToolRefs],
		allowedTools: [...PI_BRIDGE_NATIVE_TOOLS, ...mcpToolRefs],
		resources: [] as string[],
		mcpServers: {} as Record<string, unknown>,
		includeMcpJson: false,
	};
}

/**
 * Ensure the pi-bridge Kiro agent config in ~/.config/kiro/agents/ is present
 * and current. Regenerated each session so newly configured MCP servers get
 * their `@server` tool entries. Only rewrites when the content actually changes.
 */
export function ensurePiBridgeAgent(cwd: string = process.cwd()): void {
	try {
		const home = process.env.HOME;
		if (!home) return;
		const dir = resolvePath(home, ".config/kiro/agents");
		const file = resolvePath(dir, `${PI_BRIDGE_AGENT_NAME}.json`);
		const serverNames = discoverMcpServers(cwd).map((s) => s.name);
		const next = JSON.stringify(buildPiBridgeAgentConfig(serverNames), null, 2) + "\n";
		if (existsSync(file)) {
			try {
				if (readFileSync(file, "utf8") === next) return;
			} catch {}
		}
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, next, "utf8");
		process.stderr.write(
			`[kiro-provider] Wrote Kiro agent config at ${file} (mcp: ${serverNames.join(", ") || "none"})\n`,
		);
	} catch (e) {
		process.stderr.write(
			`[kiro-provider] Warning: could not install pi-bridge Kiro agent (${e instanceof Error ? e.message : e}). Context passthrough may be weakened.\n`,
		);
	}
}

// =============================================================================
// KiroSession — owns the ACP client and runs the initialize + session/new handshake.
// =============================================================================

interface InitializeResult {
	protocolVersion: number;
	agentCapabilities: Record<string, unknown>;
	agentInfo?: { name: string; version: string };
}

interface SessionNewResult {
	sessionId: string;
	modes?: unknown;
	models?: unknown;
}

export class KiroSession {
	readonly client: ACPClient;
	sessionId: string | null = null;
	/** Number of pi messages already forwarded to Kiro. Used for delta-send. */
	lastMessageCount = 0;
	/** Last pi systemPrompt forwarded. Used to detect updates. */
	lastSystemPrompt: string | undefined = undefined;
	/** Kiro model id currently selected via session/set_model. */
	currentModelId: string | null = null;

	constructor(client: ACPClient) {
		this.client = client;
	}

	/** Spawn the process and complete the initialize + session/new handshake. */
	static async create(cwd: string): Promise<KiroSession> {
		ensurePiBridgeAgent(cwd);
		const { command, args } = resolveKiroCommand();
		const client = new ACPClient(command, args);
		await client.start();
		const session = new KiroSession(client);

		// Drain session/update notifications (Kiro sends many during startup) so the
		// readline buffer doesn't fill up. We don't act on them here; the streamSimple
		// handler will process them per-prompt.
		client.setNotificationHandler(() => {});

		await session.initialize();
		await session.createSession(cwd);
		return session;
	}

	private async initialize(): Promise<InitializeResult> {
		return this.client.request<InitializeResult>("initialize", {
			protocolVersion: 1,
			clientCapabilities: {
				fs: { readTextFile: true, writeTextFile: true },
				terminal: true,
			},
			clientInfo: { name: "pi-coding-agent", version: "1.0.0" },
		});
	}

	private async createSession(cwd: string): Promise<SessionNewResult> {
		const mcpServers = discoverMcpServers(cwd);
		if (mcpServers.length > 0) {
			process.stderr.write(
				`[kiro-provider] Forwarding ${mcpServers.length} MCP server(s) to Kiro: ${mcpServers.map((s) => s.name).join(", ")}\n`,
			);
		}
		const result = await this.client.request<SessionNewResult>("session/new", {
			cwd,
			mcpServers,
		});
		this.sessionId = result.sessionId;
		// Track whatever Kiro reports as the current model (usually "auto"). We
		// only send `session/set_model` when pi selects a different model.
		const models = result.models as { currentModelId?: string } | undefined;
		if (models?.currentModelId) this.currentModelId = models.currentModelId;
		return result;
	}

	/** Switch Kiro's backing model for this session if it differs from current. */
	async ensureModel(modelId: string): Promise<void> {
		if (!this.sessionId) return;
		if (this.currentModelId === modelId) return;
		try {
			await this.client.request("session/set_model", {
				sessionId: this.sessionId,
				modelId,
			});
			this.currentModelId = modelId;
		} catch (e) {
			process.stderr.write(
				`[kiro-provider] session/set_model failed for ${modelId}: ${e instanceof Error ? e.message : e}\n`,
			);
		}
	}

	async stop(): Promise<void> {
		await this.client.stop();
		sharedSession = null;
	}
}

// =============================================================================
// Transcript rendering — pi's Context is stateless, but Kiro maintains its own
// session state. We forward the delta since the last prompt so Kiro's history
// doesn't double up. The first prompt of a session includes the system prompt
// and any pre-existing history as a preamble.
// =============================================================================

function stringifyUserOrToolContent(
	content: string | Array<TextContent | ImageContent>,
): string {
	if (typeof content === "string") return content;
	return content
		.map((b) => {
			if (b.type === "text") return b.text;
			if (b.type === "image") return "[image omitted]";
			return "";
		})
		.join("");
}

function renderUserMessage(msg: UserMessage): string {
	const text = stringifyUserOrToolContent(msg.content);
	return `<user>\n${text}\n</user>`;
}

function renderAssistantMessage(msg: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of msg.content) {
		if ((block as TextContent).type === "text") {
			parts.push((block as TextContent).text);
		} else if ((block as ThinkingContent).type === "thinking") {
			// Include thinking content as narrative context; models can ignore.
			parts.push(`<thinking>\n${(block as ThinkingContent).thinking}\n</thinking>`);
		} else if ((block as ToolCall).type === "toolCall") {
			const call = block as ToolCall;
			const args = JSON.stringify(call.arguments ?? {});
			parts.push(
				`<tool_call name="${call.name}" id="${call.id}">${args}</tool_call>`,
			);
		}
	}
	return `<assistant>\n${parts.join("\n")}\n</assistant>`;
}

function renderToolResultMessage(msg: ToolResultMessage): string {
	const text = stringifyUserOrToolContent(msg.content);
	return `<tool_result tool="${msg.toolName}" id="${msg.toolCallId}" is_error="${msg.isError}">\n${text}\n</tool_result>`;
}

export function renderMessage(msg: Message): string {
	if (msg.role === "user") return renderUserMessage(msg);
	if (msg.role === "assistant") return renderAssistantMessage(msg);
	if (msg.role === "toolResult") return renderToolResultMessage(msg);
	return "";
}

interface BuiltPrompt {
	text: string;
	/** Number of messages consumed from context.messages. Callers persist this
	 *  as `session.lastMessageCount` after a successful send. */
	newMessageCount: number;
	/** systemPrompt value that was reflected in this prompt (or undefined). */
	systemPromptForwarded: string | undefined;
}

/**
 * Build the prompt text to send to Kiro for this turn.
 *
 * Delta strategy:
 * - If `lastMessageCount === 0` (first prompt of a session), emit the system
 *   prompt (if any) and all prior messages as a preamble.
 * - Otherwise, emit only messages after `lastMessageCount` as preamble.
 * - If `messages.length < lastMessageCount`, treat as history-shrink and
 *   restart from index 0.
 * - If the systemPrompt changed since last send, emit a
 *   `<pi-system-prompt-update>` block so the model sees the change.
 *
 * The final user message (must be role=user) is rendered as the current turn
 * without a wrapper; anything else in the delta lives inside `<pi-transcript>`.
 */
export function buildPromptFromContext(
	context: Context & { cwd?: string },
	lastMessageCount: number,
	lastSystemPrompt: string | undefined,
): BuiltPrompt {
	const messages = context.messages ?? [];
	if (messages.length === 0) {
		throw new Error("Cannot build prompt: no messages in context");
	}

	// Divergence: pi's history shrank (rare, e.g. session reset). Resend all.
	let effectiveStart = lastMessageCount;
	if (messages.length < lastMessageCount) {
		effectiveStart = 0;
	}

	const delta = messages.slice(effectiveStart);
	if (delta.length === 0) {
		// No new messages; likely a duplicate call. Fall back to re-sending the
		// last user message so Kiro has something to respond to.
		effectiveStart = messages.length - 1;
	}
	const window = messages.slice(effectiveStart);

	// The last message in the window is the "current turn." If it's not a user
	// message, we still emit it inside <pi-transcript> and fall back to a
	// generic continuation ask so Kiro has something to reply to.
	const last = window[window.length - 1];
	const priorInWindow = window.slice(0, -1);

	const preambleParts: string[] = [];

	const isFirstSend = effectiveStart === 0;
	const systemPromptChanged =
		context.systemPrompt !== lastSystemPrompt && context.systemPrompt;

	if (isFirstSend && context.systemPrompt) {
		preambleParts.push(
			`<pi-system-prompt>\n${context.systemPrompt}\n</pi-system-prompt>`,
		);
	} else if (systemPromptChanged) {
		preambleParts.push(
			`<pi-system-prompt-update>\n${context.systemPrompt}\n</pi-system-prompt-update>`,
		);
	}

	if (priorInWindow.length > 0) {
		const rendered = priorInWindow.map(renderMessage).filter(Boolean).join("\n\n");
		preambleParts.push(`<pi-transcript>\n${rendered}\n</pi-transcript>`);
	}

	let currentTurnText: string;
	if (last.role === "user") {
		currentTurnText = stringifyUserOrToolContent(last.content);
	} else {
		// Non-user tail (shouldn't happen in normal pi flow). Wrap it and add a
		// generic ask so Kiro has a hook to reply against.
		currentTurnText = `${renderMessage(last)}\n\nPlease continue.`;
	}

	const preamble = preambleParts.join("\n\n");
	const text = preamble ? `${preamble}\n\n${currentTurnText}` : currentTurnText;

	return {
		text,
		newMessageCount: messages.length,
		systemPromptForwarded: context.systemPrompt,
	};
}

// =============================================================================
// streamSimple — sends a prompt and streams agent_message_chunk notifications
// as text_delta events. One KiroSession per pi process; prompts are serialized.
// =============================================================================

/** Shared session across all streamSimple calls in this pi process. */
let sharedSession: Promise<KiroSession> | null = null;

export function getSession(cwd: string): Promise<KiroSession> {
	if (!sharedSession) {
		sharedSession = KiroSession.create(cwd).catch((e) => {
			sharedSession = null; // allow retry on next call
			throw e;
		});
	}
	return sharedSession;
}

/** Stop the shared session if one exists. Safe to call when no session is running. */
export async function stopSharedSession(): Promise<void> {
	const session = await sharedSession?.catch(() => null);
	sharedSession = null;
	if (session) await session.stop();
}

// Clean up the kiro-cli-chat process when pi exits
for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		// Synchronous best-effort: send SIGTERM. stop() is async but exit handlers are sync.
		// We accept that the process might not fully drain on signal-based exit.
		stopSharedSession().catch(() => {});
	});
}

export function streamKiro(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			stream.push({ type: "start", partial: output });

			const session = await getSession(context.cwd || process.cwd());
			// Route to the pi-selected model. No-op if already active.
			await session.ensureModel(model.id);

			let built: BuiltPrompt;
			try {
				built = buildPromptFromContext(
					context,
					session.lastMessageCount,
					session.lastSystemPrompt,
				);
			} catch (e) {
				throw e instanceof Error ? e : new Error(String(e));
			}
			const text = built.text;

			// Set up notification handler to push text deltas
			const onAbort = () => { /* signal aborted is checked below */ };
			options?.signal?.addEventListener("abort", onAbort);

			// Collect session/update notifications into the output
			session.client.setNotificationHandler((notif) => {
				if (notif.method !== "session/update") return;
				const params = notif.params as { sessionId: string; update: any } | undefined;
				if (!params || params.sessionId !== session.sessionId) return;
				const update = params.update;
				if (update?.sessionUpdate === "agent_message_chunk") {
					const content = update.content;
					if (content?.type === "text" && content.text) {
						const delta = content.text;
						if (output.content.length === 0 || output.content[0].type !== "text") {
							output.content.unshift({ type: "text", text: "" });
						}
						(output.content[0] as TextContent).text += delta;
						stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
					}
				}
			});

			// Send the prompt and wait for the response (which has stopReason)
			const promptPromise = session.client.request<{ stopReason: string }>("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text }],
			});

			// If aborted before prompt completes, send session/cancel
			const abortHandler = async () => {
				if (!options?.signal?.aborted) return;
				try {
					session.client.notify("session/cancel", { sessionId: session.sessionId });
				} catch {}
			};
			options?.signal?.addEventListener("abort", abortHandler);

			const result = await promptPromise;
			// Kiro has processed the turn (success or cancel). Record what we sent
			// so the next call only forwards the delta.
			session.lastMessageCount = built.newMessageCount;
			session.lastSystemPrompt = built.systemPromptForwarded;
			const wasAborted = options?.signal?.aborted;
			if (wasAborted || result.stopReason === "cancelled") {
				output.stopReason = "aborted";
				if (output.content.length > 0 && output.content[0].type === "text") {
					stream.push({ type: "text_end", contentIndex: 0, content: (output.content[0] as TextContent).text, partial: output });
				}
				stream.push({ type: "error", reason: "aborted", error: output });
				stream.end();
				return;
			}
			output.stopReason = result.stopReason === "toolUse" ? "toolUse" : "stop";

			// Close the text block
			if (output.content.length > 0 && output.content[0].type === "text") {
				stream.push({ type: "text_end", contentIndex: 0, content: (output.content[0] as TextContent).text, partial: output });
			}

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// Models — all 15 Kiro models registered as a flat list.
// Costs are 0 because Kiro uses credit-based subscription pricing, not $/token.
// =============================================================================

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

const kiroModels: Array<{ id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean }> = [
	{ id: "auto", name: "Auto", contextWindow: 1_000_000, maxTokens: 8192, reasoning: false },
	{ id: "claude-sonnet-5", name: "Claude Sonnet 5 (Experimental)", contextWindow: 1_000_000, maxTokens: 8192, reasoning: false },
	{ id: "claude-opus-4.8", name: "Claude Opus 4.8", contextWindow: 1_000_000, maxTokens: 8192, reasoning: false },
	{ id: "claude-opus-4.7", name: "Claude Opus 4.7", contextWindow: 1_000_000, maxTokens: 8192, reasoning: false },
	{ id: "claude-opus-4.6", name: "Claude Opus 4.6", contextWindow: 1_000_000, maxTokens: 8192, reasoning: false },
	{ id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", contextWindow: 1_000_000, maxTokens: 8192, reasoning: false },
	{ id: "claude-opus-4.5", name: "Claude Opus 4.5", contextWindow: 200_000, maxTokens: 8192, reasoning: false },
	{ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", contextWindow: 200_000, maxTokens: 8192, reasoning: false },
	{ id: "claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: 200_000, maxTokens: 8192, reasoning: false },
	{ id: "claude-haiku-4.5", name: "Claude Haiku 4.5", contextWindow: 200_000, maxTokens: 8192, reasoning: false },
	{ id: "deepseek-3.2", name: "DeepSeek V3.2 (Experimental)", contextWindow: 164_000, maxTokens: 8192, reasoning: false },
	{ id: "minimax-m2.5", name: "MiniMax M2.5", contextWindow: 196_000, maxTokens: 8192, reasoning: false },
	{ id: "minimax-m2.1", name: "MiniMax M2.1 (Experimental)", contextWindow: 196_000, maxTokens: 8192, reasoning: false },
	{ id: "glm-5", name: "GLM-5", contextWindow: 200_000, maxTokens: 8192, reasoning: false },
	{ id: "qwen3-coder-next", name: "Qwen3 Coder Next (Experimental)", contextWindow: 256_000, maxTokens: 8192, reasoning: false },
];

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider("kiro", {
		name: "Kiro (via ACP)",
		api: "kiro-acp",
		baseUrl: "kiro-acp://local", // placeholder; actual transport is ACP stdio via streamSimple
		apiKey: "kiro-acp",
		models: kiroModels.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: ["text"] as ("text" | "image")[],
			cost: { ...ZERO_COST },
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
		streamSimple: streamKiro,
	});
}
