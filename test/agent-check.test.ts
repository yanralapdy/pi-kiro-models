// Manually poke the ACP: initialize + session/new + prompt with a system-prompt
// override and see what Kiro's identity is. Also surfaces stderr so we can tell
// if --agent pi-bridge is actually being loaded.
// Run: jiti test/agent-check.test.ts

import { ACPClient, resolveKiroCommand } from "../index.ts";

async function main() {
	const { command, args } = resolveKiroCommand();
	console.log("Launching:", command, args.join(" "));
	const client = new ACPClient(command, args);
	client.setStderrHandler((line) => {
		process.stderr.write(`[kiro stderr] ${line}\n`);
	});
	await client.start();

	client.setNotificationHandler((notif) => {
		if (notif.method === "session/update") {
			const p: any = notif.params;
			if (p?.update?.sessionUpdate === "agent_message_chunk") {
				process.stdout.write(p.update.content?.text ?? "");
			}
		}
	});

	const initResult = await client.request<any>("initialize", {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
		clientInfo: { name: "agent-check", version: "0.0.0" },
	});
	console.log("\ninitialize agentInfo:", initResult.agentInfo);

	const sessResult = await client.request<any>("session/new", { cwd: "/tmp", mcpServers: [] });
	console.log("session/new keys:", Object.keys(sessResult));
	console.log("session/new sessionId:", sessResult.sessionId);
	if (sessResult.models) console.log("session/new models:", JSON.stringify(sessResult.models).slice(0, 300));
	if (sessResult.modes) console.log("session/new modes:", JSON.stringify(sessResult.modes).slice(0, 300));

	console.log("\n--- Sending prompt: 'who are you?' ---\n");
	const result = await client.request<any>("session/prompt", {
		sessionId: sessResult.sessionId,
		prompt: [{ type: "text", text: "Who are you? Answer in one sentence." }],
	});
	console.log(`\n--- stopReason: ${result.stopReason} ---`);

	await client.stop();
	process.exit(0);
}

main().catch((e) => {
	console.error("✗ failed:", e);
	process.exit(1);
});
