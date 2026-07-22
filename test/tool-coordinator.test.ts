// Test: suspended Kiro-to-Pi handoff state machine.
// Run: jiti test/tool-coordinator.test.ts

import { KiroToolCoordinator } from "../tool-coordinator.ts";

function assert(condition: unknown, label: string): void {
	if (!condition) {
		console.error(`✗ ${label}`);
		process.exit(1);
	}
	console.log(`✓ ${label}`);
}

async function main(): Promise<void> {
	const coordinator = new KiroToolCoordinator();
	coordinator.startPrompt();

	const resultPromise = coordinator.beginCall({
		requestId: 7,
		kiroName: "peer_send",
		piName: "peer_send",
		arguments: { role: "tester", message: "hello" },
		signal: new AbortController().signal,
	});
	const handoff = await coordinator.waitForHandoff();
	assert(handoff.piToolCallId === "kiro-1", "handoff gets an internal monotonic Pi tool call id");
	assert(handoff.piName === "peer_send" && handoff.kiroName === "peer_send", "handoff preserves both tool names");
	assert(handoff.arguments.message === "hello", "handoff preserves arguments");
	assert(coordinator.resolveToolResult("wrong", "peer_send", { content: [{ type: "text", text: "no" }] }) === false, "mismatched tool result is ignored");
	assert(coordinator.resolveToolResult(handoff.piToolCallId, "peer_send", { content: [{ type: "text", text: "sent" }] }), "matching tool result resolves the pending call");
	const result = await resultPromise;
	assert(result.content[0]?.text === "sent", "resolved result returns MCP content");

	const nextHandoff = coordinator.waitForHandoff();
	const nextResult = coordinator.beginCall({
		requestId: 7,
		kiroName: "peer_send",
		piName: "peer_send",
		arguments: {},
		signal: new AbortController().signal,
	});
	const next = await nextHandoff;
	assert(next.piToolCallId === "kiro-2" && next.piToolCallId !== handoff.piToolCallId, "reused MCP ids still get distinct Pi ids");
	assert(coordinator.resolveToolResult(next.piToolCallId, "peer_send", { content: [{ type: "text", text: "second" }] }), "second matching result resolves independently");
	assert((await nextResult).content[0]?.text === "second", "second result matches the second Pi id");

	const cancelledResult = coordinator.beginCall({
		requestId: 7,
		kiroName: "peer_send",
		piName: "peer_send",
		arguments: {},
		signal: new AbortController().signal,
	});
	await coordinator.waitForHandoff();
	coordinator.rejectPending(new Error("cancelled"));
	await cancelledResult.then(() => assert(false, "rejected pending call must not resolve"), () => console.log("✓ rejected pending call propagates an error"));

	coordinator.finishPrompt();
	await coordinator.waitForHandoff().then(() => assert(false, "finished prompt must not yield a handoff"), () => console.log("✓ finished prompt rejects future handoff waits"));

	console.log("✓ all coordinator tests passed");
}

main().catch((error) => {
	console.error(`✗ coordinator test failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
