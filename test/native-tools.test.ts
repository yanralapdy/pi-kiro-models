// Test: the native tool list handed to the pi-bridge Kiro agent uses kiro-cli's
// current primary tool names. Regression guard for the 0.4.1 fix where the
// stale `execute_bash` name silently stripped the shell tool from bridged
// models (kiro-cli renamed it to `shell`).
// Run: jiti test/native-tools.test.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: unknown, label: string): void {
	if (!condition) {
		console.error(`✗ ${label}`);
		process.exit(1);
	}
	console.log(`✓ ${label}`);
}

const source = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf8");
const match = source.match(/const PI_BRIDGE_NATIVE_TOOLS = \[([^\]]*)\]/);
assert(match, "PI_BRIDGE_NATIVE_TOOLS is defined in index.ts");

const tools = [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

assert(tools.includes("shell"), "native tools include the shell tool");
assert(!tools.includes("execute_bash"), "native tools do not use the stale execute_bash alias");
assert(tools.includes("read") && tools.includes("write"), "native tools use primary read/write names");
assert(!tools.includes("fs_read") && !tools.includes("fs_write"), "native tools do not use the stale fs_read/fs_write aliases");

console.log("✓ all native-tools tests passed");
process.exit(0);
