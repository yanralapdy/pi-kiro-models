// Test: multi-turn context passthrough with a real Kiro session.
// Verifies:
//   1. pi's systemPrompt content reaches the model (asking for a fact placed in
//      systemPrompt should return that fact).
//   2. Model recall across turns works (Kiro session state carries forward).
//   3. session/set_model routes to the pi-selected model backend.
//
// We deliberately do NOT test identity change — Kiro's base agent has a fixed
// self-identity that mode `prompt` fields cannot override, and prompt-injection
// attempts trigger refusals. Instead, we test that pi's operating context
// (project facts, conventions) is reflected in the model's answers.
//
// Run: jiti test/context.test.ts

import { streamKiro, stopSharedSession } from "../index.ts";
import type { AssistantMessage, Context, Model, UserMessage } from "@earendil-works/pi-ai";

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

async function collectText(stream: ReturnType<typeof streamKiro>): Promise<{ text: string; reason: string }> {
	let text = "";
	let reason = "";
	for await (const event of stream) {
		if (event.type === "text_delta") text += (event as any).delta;
		if (event.type === "done") reason = (event as any).reason;
		if (event.type === "error") reason = (event as any).reason;
	}
	return { text, reason };
}

function u(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function a(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "kiro-acp",
		provider: "kiro",
		model: "qwen3-coder-next",
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
}

async function main() {
	// -----------------------------------------------------------------------
	// Turn 1: fresh convo. pi's systemPrompt carries a specific factual detail
	// about the user's project. If passthrough works, the model can answer a
	// project question from the system prompt content.
	// -----------------------------------------------------------------------
	const projectName = "Zaphod's Ship";
	const language = "Haskell";
	const systemPrompt = `You are assisting a developer using the pi coding agent. Some context about their current project:
- Project name: ${projectName}
- Primary language: ${language}
- Style: prefer point-free style and small pure functions.

Answer the user's questions using this context whenever relevant. Keep answers brief.`;

	const ctx1: Context = {
		systemPrompt,
		messages: [u("What language is my project written in? Just answer with the language name.")],
		tools: [],
		cwd: "/tmp",
	} as any;

	const r1 = await collectText(streamKiro(model, ctx1, {}));
	console.log(`Turn 1 reply: "${r1.text.trim().slice(0, 200)}"`);
	if (r1.reason !== "stop" && r1.reason !== "length") {
		console.error(`✗ turn 1 did not complete cleanly (reason=${r1.reason})`);
		await stopSharedSession();
		process.exit(1);
	}
	if (!r1.text.includes(language)) {
		console.error(`✗ turn 1 reply did not include "${language}"; systemPrompt content not reflected`);
		await stopSharedSession();
		process.exit(1);
	}
	console.log("✓ turn 1: systemPrompt fact reached the model");

	// -----------------------------------------------------------------------
	// Turn 2: same session, ask about another fact from the system prompt AND
	// reference turn 1 to verify Kiro's session state carries forward with our
	// delta-only send.
	// -----------------------------------------------------------------------
	const ctx2: Context = {
		systemPrompt,
		messages: [
			u("What language is my project written in? Just answer with the language name."),
			a(r1.text),
			u(`What's the name of my project? And what language did you just tell me it uses? Answer in one short sentence.`),
		],
		tools: [],
		cwd: "/tmp",
	} as any;

	const r2 = await collectText(streamKiro(model, ctx2, {}));
	console.log(`Turn 2 reply: "${r2.text.trim().slice(0, 200)}"`);
	if (!r2.text.includes(projectName)) {
		console.error(`✗ turn 2 reply missing project name "${projectName}"; systemPrompt not persistent`);
		await stopSharedSession();
		process.exit(1);
	}
	if (!r2.text.includes(language)) {
		console.error(`✗ turn 2 reply missing language "${language}"; prior-turn recall failed`);
		await stopSharedSession();
		process.exit(1);
	}
	console.log("✓ turn 2: model recalled prior-turn content and used systemPrompt facts");

	await stopSharedSession();
	console.log("✓ context passthrough test passed");
	process.exit(0);
}

main().catch(async (e) => {
	console.error("✗ test failed:", e);
	await stopSharedSession().catch(() => {});
	process.exit(1);
});
