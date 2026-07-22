// Test: configured stdio Kiro MCP discovery remains unchanged.
// Run: jiti test/mcp-discovery.test.ts

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { discoverMcpServers, KiroSession } from "../index.ts";

function assert(condition: unknown, label: string): void {
	if (!condition) {
		console.error(`✗ ${label}`);
		process.exit(1);
	}
	console.log(`✓ ${label}`);
}

async function main(): Promise<void> {
	const root = await mkdtemp(resolve(tmpdir(), "pi-kiro-mcp-"));
	const oldHome = process.env.HOME;
	try {
		process.env.HOME = root;
		await mkdir(resolve(root, ".config/kiro/settings"), { recursive: true });
		await mkdir(resolve(root, ".kiro/settings"), { recursive: true });
		await writeFile(resolve(root, ".config/kiro/settings/mcp.json"), JSON.stringify({
			mcpServers: {
				global: { command: "/bin/global", args: ["--old"], env: { TOKEN: "secret" } },
				ignored: { command: "/bin/ignored", disabled: true },
			},
		}));
		await writeFile(resolve(root, ".kiro/settings/mcp.json"), JSON.stringify({
			mcpServers: { global: { command: "/bin/override", args: ["--new"] } },
		}));
		const workspace = await mkdtemp(resolve(tmpdir(), "pi-kiro-workspace-"));
		try {
			const servers = discoverMcpServers(workspace);
			assert(servers.length === 1, "disabled and duplicate MCP entries are filtered/unioned");
			assert(servers[0]?.name === "global" && servers[0].command === "/bin/override", "later config overrides by name");
			assert(servers[0]?.args[0] === "--new", "override arguments are preserved");

			const requests: Array<{ method: string; params: any }> = [];
			const fakeClient = {
				setExitHandler() {},
				request: async (method: string, params: any) => {
					requests.push({ method, params });
					return { sessionId: "fake-session" };
				},
			} as any;
			const directSession = new KiroSession(fakeClient);
			await (directSession as any).createSession(workspace);
			const directPayload = requests[0]?.params.mcpServers;
			assert(JSON.stringify(directPayload) === JSON.stringify(servers), "stdio MCP payload is preserved unchanged without host bridge");

			const hostSession = new KiroSession(fakeClient);
			hostSession.toolBridge = {
				port: 12345,
				url: "http://127.0.0.1:12345/mcp",
				token: "test-token",
				close: async () => {},
			};
			await (hostSession as any).createSession(workspace);
			const hostPayload = requests[1]?.params.mcpServers;
			assert(hostPayload.length === servers.length + 1, "pi_host is appended only when host bridge is enabled");
			assert(JSON.stringify(hostPayload.slice(0, servers.length)) === JSON.stringify(servers), "host bridge does not reshape configured stdio entries");
			assert(hostPayload.at(-1)?.type === "http" && hostPayload.at(-1)?.name === "pi_host", "host bridge uses an ACP HTTP MCP entry");
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
		console.log("✓ MCP discovery regression passed");
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		await rm(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(`✗ MCP discovery test failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
