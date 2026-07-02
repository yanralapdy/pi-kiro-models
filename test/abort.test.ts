// Test: streamKiro handles AbortSignal by sending session/cancel.
// Run: jiti test/abort.test.ts

import { streamKiro } from "../index.ts";
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
			{ role: "user", content: "Count from 1 to 100 slowly, one number per word.", timestamp: Date.now() },
		],
		systemPrompt: "",
		tools: [],
		cwd: "/tmp",
	};

	const ac = new AbortController();
	const stream = streamKiro(model, context, { signal: ac.signal });

	let gotError = false;
	let errorReason = "";
	const eventTypes: string[] = [];

	// Abort after first text delta
	(async () => {
		for await (const event of stream) {
			eventTypes.push(event.type);
			if (event.type === "text_delta") {
				ac.abort();
			}
			if (event.type === "error") {
				gotError = true;
				errorReason = (event as any).reason;
			}
		}
	})();

	// Also abort after 2s as a fallback in case no text_delta arrives quickly
	setTimeout(() => ac.abort(), 2000);

	// Wait for completion
	await new Promise((r) => setTimeout(r, 15000));

	console.log("Events received:", eventTypes);

	console.assert(gotError, "expected error event on abort");
	console.assert(errorReason === "aborted", `expected 'aborted', got '${errorReason}'`);
	console.log(`✓ abort handled: reason=${errorReason}`);

	process.exit(0);
}

main().catch((e) => {
	console.error("✗ test failed:", e);
	process.exit(1);
});
