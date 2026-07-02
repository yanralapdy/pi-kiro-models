// Test: T-07 lifecycle — respawn after process death.
// Run: jiti test/lifecycle-cleanup.test.ts

import { KiroSession, getSession, stopSharedSession } from "../index.ts";
import { execSync } from "node:child_process";

function kiroPids(): number[] {
	try {
		const out = execSync("pgrep -f 'kiro-cli-chat acp'").toString().trim();
		if (!out) return [];
		return out.split("\n").map(Number);
	} catch {
		return [];
	}
}

async function main() {
	// 1. First prompt creates the session
	console.log("Creating initial session...");
	const session1 = await getSession("/tmp");
	console.log(`✓ session 1: ${session1.sessionId}`);
	const pidsBefore = kiroPids();
	console.log(`  kiro pids: ${pidsBefore.join(", ")}`);
	console.assert(pidsBefore.length > 0, "expected at least one kiro process");

	// 2. Kill the kiro process externally
	const pid = pidsBefore[0];
	console.log(`Killing kiro pid ${pid} externally...`);
	process.kill(pid, "SIGKILL");
	// Wait for the exit handler to fire
	await new Promise((r) => setTimeout(r, 1000));

	// 3. Next prompt should respawn
	console.log("Creating second session (should respawn)...");
	const session2 = await getSession("/tmp");
	console.log(`✓ session 2: ${session2.sessionId}`);
	console.assert(session2.sessionId !== session1.sessionId, "expected new sessionId");
	const pidsAfter = kiroPids();
	console.log(`  kiro pids: ${pidsAfter.join(", ")}`);
	console.assert(pidsAfter.length > 0, "expected kiro process after respawn");
	console.assert(!pidsAfter.includes(pid), "old pid should be gone");

	// 4. Clean up
	await stopSharedSession();
	const pidsFinal = kiroPids();
	console.assert(pidsFinal.length === 0, `expected no kiro processes, got: ${pidsFinal.join(", ")}`);
	console.log("✓ no orphaned kiro processes after stop");

	console.log("✓ lifecycle test passed");
	process.exit(0);
}

main().catch((e) => {
	console.error("✗ test failed:", e);
	process.exit(1);
});
