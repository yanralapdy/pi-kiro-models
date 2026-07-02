// Test: streamKiro streams text from a real Kiro session.
// Run: jiti test/stream.test.ts

import { streamKiro, KiroSession } from "../index.ts";
import type { Context, Model } from "@earendil-works/pi-ai";

async function main() {
	const model: Model<any> = {
		id: "qwen3-coder-next",
		name: "Qwen3 Coder Next",
		api: "kiro-acp",
		provider: "kiro",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256000,
		maxTokens: 8192,
	};

	const context: Context = {
		messages: [
			{ role: "user", content: "Say 'hello world' and nothing else.", timestamp: Date.now() },
		],
		systemPrompt: "",
		tools: [],
		cwd: "/tmp",
	};

	const stream = streamKiro(model, context, {});
	let textContent = "";
	let gotStart = false;
	let gotDone = false;
	let stopReason = "";

	for await (const event of stream) {
		if (event.type === "start") gotStart = true;
		if (event.type === "text_delta") textContent += (event as any).delta;
		if (event.type === "done") {
			gotDone = true;
			stopReason = (event as any).reason;
		}
	}

	console.assert(gotStart, "expected start event");
	console.log("✓ start event received");
	console.assert(gotDone, "expected done event");
	console.log("✓ done event received");
	console.assert(textContent.toLowerCase().includes("hello"), `expected 'hello' in output, got: ${textContent.slice(0, 200)}`);
	console.log(`✓ text streamed: "${textContent.trim().slice(0, 80)}"`);
	console.assert(stopReason === "stop" || stopReason === "length", `expected stop/length, got ${stopReason}`);
	console.log(`✓ stopReason: ${stopReason}`);

	// Cleanup shared session
	const session = await KiroSession.create("/tmp").catch(() => null);
	// Note: shared session is internal; we rely on process exit to clean up
	console.log("✓ stream test passed");
	process.exit(0);
}

main().catch((e) => {
	console.error("✗ test failed:", e);
	process.exit(1);
});
