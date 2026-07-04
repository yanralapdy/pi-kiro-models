// Explore Kiro's ACP capabilities: what methods does session/new advertise?
// Try session/set_model, session/set_mode, etc. to find the right way to
// route pi's selected model.
// Run: jiti test/explore-acp.test.ts

import { ACPClient, resolveKiroCommand } from "../index.ts";

async function main() {
	const { command, args } = resolveKiroCommand();
	const client = new ACPClient(command, args);
	client.setStderrHandler((line) => process.stderr.write(`[kiro stderr] ${line}\n`));
	await client.start();
	client.setNotificationHandler(() => {});

	const initResult = await client.request<any>("initialize", {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
		clientInfo: { name: "explore", version: "0.0.0" },
	});
	console.log("agentCapabilities:", JSON.stringify(initResult.agentCapabilities, null, 2));

	const sessResult = await client.request<any>("session/new", { cwd: "/tmp", mcpServers: [] });
	const sessionId = sessResult.sessionId;
	console.log("\nsessionId:", sessionId);
	console.log("\nfull models block:", JSON.stringify(sessResult.models, null, 2));
	console.log("\nfull modes block:", JSON.stringify(sessResult.modes, null, 2));

	// Try model-selection methods
	const methods = [
		["session/select_model", { sessionId, modelId: "qwen3-coder-next" }],
		["session/set_model", { sessionId, modelId: "qwen3-coder-next" }],
		["session/setModel", { sessionId, modelId: "qwen3-coder-next" }],
		["session/select_mode", { sessionId, modeId: "pi-bridge" }],
		["session/set_mode", { sessionId, modeId: "pi-bridge" }],
	] as const;

	for (const [method, params] of methods) {
		try {
			const r = await client.request(method, params);
			console.log(`✓ ${method} succeeded:`, JSON.stringify(r).slice(0, 200));
		} catch (e) {
			console.log(`✗ ${method}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	await client.stop();
	process.exit(0);
}

main().catch((e) => {
	console.error("failed:", e);
	process.exit(1);
});
