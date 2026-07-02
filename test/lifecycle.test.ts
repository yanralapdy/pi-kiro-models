// Test: KiroSession completes the ACP handshake (initialize + session/new) with the real kiro-cli-chat binary.
// Run: jiti test/lifecycle.test.ts

import { KiroSession } from "../index.ts";

async function main() {
	console.log("Spawning kiro-cli-chat acp and completing handshake...");
	const session = await KiroSession.create("/tmp");

	console.assert(session.sessionId !== null && session.sessionId.length > 0, "sessionId should be set");
	console.log(`✓ initialize + session/new completed (sessionId: ${session.sessionId})`);

	await session.stop();
	console.log("✓ session stopped cleanly");
	process.exit(0);
}

main().catch((e) => {
	console.error("✗ test failed:", e);
	process.exit(1);
});
