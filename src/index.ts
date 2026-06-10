import { getAgentByName, routeAgentRequest } from "agents";
import { PersonalAgent } from "./agent";

// Durable Object classes must be exported from the Worker's entry module.
// ThinkMessengerStateAgent backs Chat SDK state as a sub-agent.
export { PersonalAgent };
export { ThinkMessengerStateAgent } from "@cloudflare/think/messengers";

const TELEGRAM_WEBHOOK_PATH = "/messengers/telegram/webhook";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const agentResponse = await routeAgentRequest(request, env);
		if (agentResponse) return agentResponse;

		const url = new URL(request.url);
		const agent = await getAgentByName(env.PersonalAgent, "default");

		if (url.pathname === TELEGRAM_WEBHOOK_PATH) {
			return agent.fetch(request);
		}

		if (url.pathname === "/setup") {
			// Telegram requires https; behind a tunnel the Worker sees http.
			const webhookUrl = `https://${url.host}${TELEGRAM_WEBHOOK_PATH}`;
			const res = await fetch(
				`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						url: webhookUrl,
						secret_token: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
						allowed_updates: ["message"],
						drop_pending_updates: true,
					}),
				},
			);
			return Response.json(
				{ ok: res.ok, webhookUrl, result: await res.json() },
				{ status: res.ok ? 200 : 502 },
			);
		}

		if (url.pathname === "/reset") {
			await agent.resetEverything();
			return Response.json({
				ok: true,
				message: "Conversation, workspace files, and Chat SDK state cleared.",
			});
		}

		return Response.json({
			name: "personal-agent",
			webhook: TELEGRAM_WEBHOOK_PATH,
			setup: "GET /setup",
			reset: "GET /reset",
		});
	},
} satisfies ExportedHandler<Env>;
