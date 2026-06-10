import type { AddMcpServerOptions } from "agents";

// MCP servers connected before every turn; their tools merge into each turn.
// Add a server by appending an entry here, or remove one by deleting it.
export function mcpServers(env: Env): {
	name: string;
	url: string;
	options: AddMcpServerOptions;
}[] {
	return [
		{
			name: "home-assistant",
			url: env.HA_MCP_URL,
			options: {
				id: "home-assistant",
				transport: {
					type: "streamable-http",
					headers: { Authorization: `Bearer ${env.HA_TOKEN}` },
				},
			},
		},
	];
}
