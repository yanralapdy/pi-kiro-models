// Test: transcript rendering + delta-send prompt building.
// Run: jiti test/transcript.test.ts

import { buildPromptFromContext, renderMessage } from "../index.ts";
import type {
	AssistantMessage,
	Context,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";

function assert(cond: unknown, label: string): void {
	if (!cond) {
		console.error(`✗ ${label}`);
		process.exit(1);
	}
	console.log(`✓ ${label}`);
}

function u(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function a(text: string, toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...toolCalls.map((tc) => ({
				type: "toolCall" as const,
				id: tc.id,
				name: tc.name,
				arguments: tc.args,
			})),
		],
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
		timestamp: 0,
	};
}

function tr(toolCallId: string, toolName: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	};
}

// ---------------------------------------------------------------------------
// Test 1: renderMessage produces the expected tag shapes
// ---------------------------------------------------------------------------
{
	const user = renderMessage(u("hello"));
	assert(user === "<user>\nhello\n</user>", "renderMessage user (string content)");

	const userArr = renderMessage({
		role: "user",
		content: [
			{ type: "text", text: "hi" },
			{ type: "image", data: "base64...", mimeType: "image/png" },
		],
		timestamp: 0,
	});
	assert(userArr.includes("hi") && userArr.includes("[image omitted]"), "renderMessage user (array content, image placeholder)");

	const assistant = renderMessage(a("thinking...", [{ id: "t1", name: "read_file", args: { path: "/tmp/x" } }]));
	assert(assistant.startsWith("<assistant>"), "renderMessage assistant opens with tag");
	assert(assistant.includes("thinking..."), "renderMessage assistant preserves text");
	assert(
		assistant.includes('<tool_call name="read_file" id="t1">{"path":"/tmp/x"}</tool_call>'),
		"renderMessage assistant emits tool_call block",
	);
	assert(assistant.endsWith("</assistant>"), "renderMessage assistant closes tag");

	const toolResult = renderMessage(tr("t1", "read_file", "file contents", false));
	assert(
		toolResult.includes('<tool_result tool="read_file" id="t1" is_error="false">'),
		"renderMessage toolResult opens with attrs",
	);
	assert(toolResult.includes("file contents"), "renderMessage toolResult preserves body");
}

// ---------------------------------------------------------------------------
// Test 2: first-send prompt includes system prompt + all history
// ---------------------------------------------------------------------------
{
	const ctx: Context = {
		systemPrompt: "You are pi's assistant.",
		messages: [u("earlier question"), a("earlier answer"), u("current question")],
		tools: [],
	};

	const built = buildPromptFromContext(ctx, 0, undefined);
	assert(built.text.includes("<pi-system-prompt>"), "first send includes system prompt tag");
	assert(built.text.includes("You are pi's assistant."), "first send includes system prompt text");
	assert(built.text.includes("<pi-transcript>"), "first send includes transcript preamble");
	assert(built.text.includes("earlier question"), "first send includes prior user turn");
	assert(built.text.includes("earlier answer"), "first send includes prior assistant turn");
	assert(built.text.endsWith("current question"), "first send ends with current user text (unwrapped)");
	assert(built.newMessageCount === 3, "first send newMessageCount matches messages.length");
	assert(built.systemPromptForwarded === "You are pi's assistant.", "first send records forwarded systemPrompt");
}

// ---------------------------------------------------------------------------
// Test 3: delta send skips system prompt and prior history
// ---------------------------------------------------------------------------
{
	const ctx: Context = {
		systemPrompt: "You are pi's assistant.",
		messages: [
			u("q1"),
			a("a1"),
			u("q2"),
		],
	};

	const built = buildPromptFromContext(ctx, 2, "You are pi's assistant.");
	assert(!built.text.includes("<pi-system-prompt>"), "delta send omits system prompt tag");
	assert(!built.text.includes("<pi-transcript>"), "delta send omits transcript preamble");
	assert(!built.text.includes("q1"), "delta send drops prior user turn");
	assert(!built.text.includes("a1"), "delta send drops prior assistant turn");
	assert(built.text === "q2", "delta send emits current user text raw");
	assert(built.newMessageCount === 3, "delta send bumps newMessageCount");
}

// ---------------------------------------------------------------------------
// Test 4: mid-conversation delta with a tool result gets wrapped
// ---------------------------------------------------------------------------
{
	const ctx: Context = {
		messages: [
			u("q1"),
			a("plan", [{ id: "t1", name: "bash", args: { cmd: "ls" } }]),
			tr("t1", "bash", "file1\nfile2"),
			u("thanks — now do this"),
		],
	};

	// Simulate: previous send stopped at message #1 (after first assistant),
	// then two new messages arrived (tool result + user).
	const built = buildPromptFromContext(ctx, 2, undefined);
	assert(built.text.includes("<pi-transcript>"), "mid-delta wraps new prior messages");
	assert(built.text.includes("<tool_result"), "mid-delta includes tool result block");
	assert(built.text.includes("file1"), "mid-delta preserves tool result body");
	assert(built.text.endsWith("thanks — now do this"), "mid-delta ends with current user text");
}

// ---------------------------------------------------------------------------
// Test 5: history-shrink triggers full resend with system prompt
// ---------------------------------------------------------------------------
{
	const ctx: Context = {
		systemPrompt: "SYS",
		messages: [u("fresh start")],
	};

	// lastMessageCount was 5 (old conversation), now messages.length is 1.
	const built = buildPromptFromContext(ctx, 5, "OLD_SYS");
	assert(built.text.includes("<pi-system-prompt>"), "history-shrink re-emits system prompt");
	assert(built.text.includes("SYS"), "history-shrink uses new system prompt value");
	assert(built.text.endsWith("fresh start"), "history-shrink current turn intact");
	assert(built.newMessageCount === 1, "history-shrink counter resets to new length");
}

// ---------------------------------------------------------------------------
// Test 6: systemPrompt change mid-session emits an update block
// ---------------------------------------------------------------------------
{
	const ctx: Context = {
		systemPrompt: "NEW",
		messages: [u("q1"), a("a1"), u("q2")],
	};

	const built = buildPromptFromContext(ctx, 2, "OLD");
	assert(built.text.includes("<pi-system-prompt-update>"), "system prompt change emits update block");
	assert(built.text.includes("NEW"), "update block uses new system prompt");
	assert(!built.text.includes("<pi-system-prompt>\n"), "update path does not use fresh-send tag");
	assert(built.text.endsWith("q2"), "update path preserves current user text");
	assert(built.systemPromptForwarded === "NEW", "forwarded systemPrompt records new value");
}

// ---------------------------------------------------------------------------
// Test 7: no systemPrompt → no tag emitted
// ---------------------------------------------------------------------------
{
	const ctx: Context = { messages: [u("hi")] };
	const built = buildPromptFromContext(ctx, 0, undefined);
	assert(!built.text.includes("<pi-system-prompt"), "no systemPrompt → no system tag");
	assert(built.text === "hi", "no-systemPrompt fresh send is just the user text");
}

// ---------------------------------------------------------------------------
// Test 8: empty messages throws
// ---------------------------------------------------------------------------
{
	let threw = false;
	try {
		buildPromptFromContext({ messages: [] }, 0, undefined);
	} catch {
		threw = true;
	}
	assert(threw, "empty messages array throws");
}

console.log("✓ all transcript tests passed");
process.exit(0);
