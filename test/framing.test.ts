// Test: ACPClient NDJSON framing round-trip with a mock echo process.
// Run: jiti test/framing.test.ts

import { ACPClient } from "../index.ts";

// Mock ACP server: reads NDJSON, responds to "ping" with "pong", echoes notifications.
const mockScript = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'ping') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { reply: 'pong' } }) + '\\n');
    } else if (msg.method === 'notify') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: msg.params }) + '\\n');
    } else if (msg.method === 'error-test') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'mock error' } }) + '\\n');
    }
  } catch (e) {}
});
`;

async function main() {
	const client = new ACPClient(process.execPath, ["-e", mockScript]);
	await client.start();

	let notificationReceived: any = null;
	client.setNotificationHandler((msg) => {
		notificationReceived = msg;
	});

	// Test 1: request/response
	const result = await client.request<{ reply: string }>("ping");
	console.assert(result.reply === "pong", `Expected pong, got ${JSON.stringify(result)}`);
	console.log("✓ request/response round-trip");

	// Test 2: notification from server
	client.notify("notify", { hello: "world" });
	await new Promise((r) => setTimeout(r, 100));
	console.assert(notificationReceived?.params?.hello === "world", `Expected notification, got ${JSON.stringify(notificationReceived)}`);
	console.log("✓ notification received from server");

	// Test 3: error response
	try {
		await client.request("error-test");
		console.error("✗ expected error to reject");
		process.exit(1);
	} catch (e: any) {
		console.assert(e.message.includes("mock error"), `Expected 'mock error', got ${e.message}`);
		console.log("✓ error response rejected");
	}

	await client.stop();
	console.log("✓ all framing tests passed");
	process.exit(0);
}

main().catch((e) => {
	console.error("✗ test failed:", e);
	process.exit(1);
});
