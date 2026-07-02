// kiro-provider: Bridges Kiro CLI models into pi via Agent Client Protocol (ACP).
// V1: chat-only bridge. Tool delegation deferred to V2 (MCP-based).

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve as resolvePath } from "node:path";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
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
	const args = ["acp", "--agent-engine", "v2", "--trust-all-tools"];
	return { command, args };
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

	constructor(client: ACPClient) {
		this.client = client;
	}

	/** Spawn the process and complete the initialize + session/new handshake. */
	static async create(cwd: string): Promise<KiroSession> {
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
		const result = await this.client.request<SessionNewResult>("session/new", {
			cwd,
			mcpServers: [],
		});
		this.sessionId = result.sessionId;
		return result;
	}

	async stop(): Promise<void> {
		await this.client.stop();
		sharedSession = null;
	}
}

// =============================================================================
// streamSimple — sends a prompt and streams agent_message_chunk notifications
// as text_delta events. One KiroSession per pi process; prompts are serialized.
// =============================================================================

/** Extract the text from the last user message in the context. */
function extractLastUserText(messages: Context["messages"]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "user") {
			if (typeof msg.content === "string") return msg.content;
			return msg.content
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("\n");
		}
	}
	return "";
}

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
			const text = extractLastUserText(context.messages);
			if (!text) {
				throw new Error("No user message to send");
			}

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
