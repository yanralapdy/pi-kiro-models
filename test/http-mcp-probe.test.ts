// Opt-in compatibility probe for Kiro ACP HTTP MCP.
// Run with an authenticated Kiro CLI:
//   KIRO_HTTP_MCP_PROBE=1 jiti test/http-mcp-probe.test.ts
//
// Findings captured by this probe (Kiro CLI 2.5.0):
// - session/new uses { type: "http", name, url, headers: [{ name, value }] }.
// - Kiro POSTs JSON-RPC to the URL with no Origin header and forwards headers.
// - initialize uses MCP protocolVersion "2025-06-18" (string).
// - Kiro sends notifications/initialized, tools/list, prompts/list, then tools/call.
// - A delayed JSON tools/call response is accepted; no SSE response is required.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { once } from "node:events";

const assert = (condition: unknown, message: string): asserts condition => {
	if (!condition) throw new Error(message);
};

const MCP_TOKEN = "probe-token";
const PROBE_VALUE = "hello";

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: any;
	result?: any;
	error?: { code?: number; message?: string };
}

interface ProbeState {
	methods: string[];
	toolCalls: Array<{ name: string; arguments: unknown }>;
	delayMs: number;
}

function sendJson(res: ServerResponse, status: number, body?: JsonRpcMessage): void {
	res.writeHead(status, body ? { "content-type": "application/json" } : undefined);
	res.end(body ? JSON.stringify(body) : undefined);
}

async function readBody(req: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of req) {
		body += String(chunk);
		if (body.length > 64 * 1024) throw new Error("request body too large");
	}
	return body;
}

function createProbeServer(state: ProbeState) {
	return createServer(async (req, res) => {
		if (req.method !== "POST" || req.url !== "/mcp") {
			sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32601, message: "not found" } });
			return;
		}
		assert(req.headers.authorization === `Bearer ${MCP_TOKEN}`, "Kiro did not forward the MCP bearer header");
		const msg = JSON.parse(await readBody(req)) as JsonRpcMessage;
		if (msg.method) state.methods.push(msg.method);

		switch (msg.method) {
			case "initialize":
				sendJson(res, 200, {
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						protocolVersion: "2025-06-18",
						capabilities: { tools: {}, prompts: {}, resources: {} },
						serverInfo: { name: "pi-probe", version: "1.0.0" },
					},
				});
				return;
			case "notifications/initialized":
				sendJson(res, 202);
				return;
			case "tools/list":
				sendJson(res, 200, {
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						tools: [{
							name: "probe_tool",
							description: "Delayed compatibility probe",
							inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
						}],
					},
				});
				return;
			case "prompts/list":
				sendJson(res, 200, { jsonrpc: "2.0", id: msg.id, result: { prompts: [] } });
				return;
			case "tools/call": {
				const name = msg.params?.name;
				const args = msg.params?.arguments;
				state.toolCalls.push({ name, arguments: args });
				const started = Date.now();
				setTimeout(() => {
					state.delayMs = Date.now() - started;
					sendJson(res, 200, {
						jsonrpc: "2.0",
						id: msg.id,
						result: { content: [{ type: "text", text: `probe-result:${JSON.stringify(args)}` }], isError: false },
					});
				}, 100);
				return;
			}
			default:
				sendJson(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
		}
	});
}

class AcpProbeClient {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	readonly notifications: JsonRpcMessage[] = [];
	constructor(private readonly proc: ChildProcess, private readonly rl: Interface) {
		rl.on("line", (line) => {
			let msg: JsonRpcMessage;
			try { msg = JSON.parse(line) as JsonRpcMessage; } catch { return; }
			if (typeof msg.id !== "number") {
				if (msg.method) this.notifications.push(msg);
				return;
			}
			const pending = this.pending.get(msg.id);
			if (!pending) return;
			this.pending.delete(msg.id);
			if (msg.error) pending.reject(new Error(msg.error.message || "ACP error"));
			else pending.resolve(msg.result);
		});
	}
	request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
		const id = this.nextId++;
		this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => { clearTimeout(timer); resolve(value); },
				reject: (error) => { clearTimeout(timer); reject(error); },
			});
		});
	}
}

async function main(): Promise<void> {
	if (process.env.KIRO_HTTP_MCP_PROBE !== "1") {
		console.log("skipped: set KIRO_HTTP_MCP_PROBE=1 to run the authenticated Kiro probe");
		return;
	}

	const state: ProbeState = { methods: [], toolCalls: [], delayMs: 0 };
	const server = createProbeServer(state);
	let proc: ChildProcess | undefined;
	let rl: Interface | undefined;
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const address = server.address();
		assert(address && typeof address === "object", "probe server did not bind");
		const url = `http://127.0.0.1:${address.port}/mcp`;

		const command = process.env.KIRO_CLI_CHAT || "kiro-cli-chat";
		proc = spawn(command, ["acp", "--agent-engine", "v2", "--trust-all-tools", "--agent", "pi-bridge"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		rl = createInterface({ input: proc.stdout! });
		proc.stderr?.on("data", () => {}); // Keep probe output quiet; never log tokens or arguments.
		const client = new AcpProbeClient(proc, rl);

		const init = await client.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
			clientInfo: { name: "pi-http-mcp-probe", version: "1.0.0" },
		});
		assert(init?.agentCapabilities?.mcpCapabilities?.http === true, "Kiro did not advertise HTTP MCP support");

		const session = await client.request("session/new", {
			cwd: process.cwd(),
			mcpServers: [{
				type: "http",
				name: "pi-probe",
				url,
				headers: [{ name: "Authorization", value: `Bearer ${MCP_TOKEN}` }],
			}],
		});
		assert(typeof session?.sessionId === "string", "session/new did not return a session id");

		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: `Call probe_tool with value \"${PROBE_VALUE}\" and return its result.` }],
		});

		assert(state.methods.includes("initialize"), "Kiro did not initialize the MCP server");
		assert(state.methods.includes("tools/list"), "Kiro did not discover MCP tools");
		const sessionUpdates = client.notifications.filter((message) => message.method === "session/update");
		assert(sessionUpdates.length > 0, "Kiro emitted no session/update notifications");
		assert(
			sessionUpdates.every((message) => message.params?.sessionId === session.sessionId),
			"session/update notification has the wrong session id",
		);
		assert(
			sessionUpdates.every((message) => typeof message.params?.update?.sessionUpdate === "string"),
			"session/update notification has no update discriminator",
		);
		const call = state.toolCalls[0];
		assert(call?.name === "probe_tool", `unexpected tool call: ${call?.name || "none"}`);
		assert((call.arguments as any)?.value === PROBE_VALUE, "Kiro sent unexpected probe arguments");
		assert(state.delayMs >= 90, `delayed tools/call response was not observed (${state.delayMs}ms)`);
		console.log("✓ Kiro HTTP MCP wire probe passed");
	} finally {
		rl?.close();
		if (proc && proc.exitCode === null && proc.signalCode === null) {
			const waitForExit = async (): Promise<void> => {
				if (proc!.exitCode !== null || proc!.signalCode !== null) return;
				await once(proc!, "exit");
			};
			proc.kill("SIGTERM");
			const exited = await Promise.race([
				waitForExit().then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
			]);
			if (!exited) {
				proc.kill("SIGKILL");
				await waitForExit();
			}
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

main().catch((error) => {
	console.error(`✗ HTTP MCP probe failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
