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

		// GitHub MCP — uncomment and add GITHUB_TOKEN to your secrets to enable.
		// See README for token setup instructions.
		//
		// IMPORTANT: use api.githubcopilot.com, NOT mcp.github.com.
		// mcp.github.com routes through Cloudflare's edge and triggers error 1016
		// from a Worker context. OAuth is also unavailable from a non-browser Worker;
		// a fine-grained PAT via Authorization header is the supported auth method.
		//
		// {
		//   name: "github",
		//   url: "https://api.githubcopilot.com/mcp/",
		//   options: {
		//     id: "github",
		//     transport: {
		//       type: "streamable-http",
		//       headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}` },
		//     },
		//   },
		// },
	];
}
