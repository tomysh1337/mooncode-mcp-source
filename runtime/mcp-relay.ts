import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio as serveMcpStdio } from "@modelcontextprotocol/server/stdio";
import {
	BRIDGE_MCP_INSTRUCTIONS,
	BRIDGE_MCP_SERVER_INFO,
	BRIDGE_MCP_SUPPORTED_PROTOCOLS,
	BRIDGE_TOOL_DEFINITIONS,
} from "@mooncode/contracts";

function relayTargetFromEnvironment(): URL {
	const raw = process.env.MOONCODE_MCP_URL?.trim();
	if (!raw) throw new Error("MOONCODE_MCP_URL is required for --mcp-relay");
	const url = new URL(raw);
	const localHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
	if (url.protocol !== "https:" && !localHttp) throw new Error("MOONCODE_MCP_URL must use HTTPS, except localhost/loopback development URLs");
	if (!/^\/mcp\/[A-Za-z0-9_-]{43,}$/.test(url.pathname)) throw new Error("MOONCODE_MCP_URL must be a full MoonCode capability/OAuth MCP resource URL");
	return url;
}

function createRelayServer(remote: Client): McpServer {
	const server = new McpServer(
		{ ...BRIDGE_MCP_SERVER_INFO, name: `${BRIDGE_MCP_SERVER_INFO.name}-stdio-relay` },
		{
			instructions: `${BRIDGE_MCP_INSTRUCTIONS}\nThis stdio endpoint is a transparent MoonCode relay. Authorization and side effects remain enforced by the target Universal MCP Bridge.`,
			supportedProtocolVersions: [...BRIDGE_MCP_SUPPORTED_PROTOCOLS],
		},
	);
	for (const definition of BRIDGE_TOOL_DEFINITIONS) {
		server.registerTool(
			definition.name,
			{
				description: definition.description,
				inputSchema: fromJsonSchema<Record<string, unknown>>(definition.inputSchema),
				annotations: definition.annotations,
			},
			async (args) => {
				try {
					return await remote.callTool({ name: definition.name, arguments: args });
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: `ERROR INTERNAL_ERROR: relay target call failed: ${error instanceof Error ? error.message : String(error)}` }],
						isError: true,
					};
				}
			},
		);
	}
	return server;
}

export async function serveMcpRelay(): Promise<void> {
	const target = relayTargetFromEnvironment();
	const remote = new Client({ name: "mooncode-stdio-relay-client", version: BRIDGE_MCP_SERVER_INFO.version });
	await remote.connect(new StreamableHTTPClientTransport(target));
	const handle = serveMcpStdio(() => createRelayServer(remote), {
		legacy: "serve",
		onerror: error => process.stderr.write(`[mooncode-mcp-relay] ${error.message}\n`),
	});
	let closing = false;
	const close = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		await handle.close().catch(() => undefined);
		await remote.close().catch(() => undefined);
	};
	process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
	process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
}
