import { getAgentByName, routeAgentRequest } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import { Think, type Session } from "@cloudflare/think";
import {
	defineMessengers,
	ThinkMessengerStateAgent,
	type ThinkMessengers,
} from "@cloudflare/think/messengers";
import telegramMessenger from "@cloudflare/think/messengers/telegram";
import { createBrowserTools } from "@cloudflare/think/tools/browser";
import puppeteer from "@cloudflare/puppeteer";
import { tool } from "ai";
import { z } from "zod";

// Backs Chat SDK state; the framework routes to it as a sub-agent.
export { ThinkMessengerStateAgent };

const TELEGRAM_WEBHOOK_PATH = "/messengers/telegram/webhook";

export class PersonalAgent extends Think<Env> {
	// Connect Home Assistant's MCP tools before the first turn runs.
	waitForMcpConnections = true;

	override getModel() {
		return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.6");
	}

	override getSystemPrompt() {
		return [
			"You are a friendly, concise assistant replying inside a Telegram chat.",
			"Keep answers short and easy to read on a phone.",
		].join("\n");
	}

	// Connect Home Assistant over MCP; its device tools merge into every turn.
	override async configureSession(session: Session): Promise<Session> {
		try {
			const result = await this.addMcpServer(
				"home-assistant",
				this.env.HA_MCP_URL,
				{
					id: "home-assistant",
					transport: {
						type: "streamable-http",
						headers: { Authorization: `Bearer ${this.env.HA_TOKEN}` },
					},
				},
			);
			if (result.state !== "ready") {
				console.error("Home Assistant MCP not ready:", result);
			}
		} catch (err) {
			console.error("Home Assistant MCP connection failed:", err);
		}
		return session;
	}

	override getTools() {
		return {
			...createBrowserTools({
				browser: this.browserBinding,
				loader: this.env.LOADER,
			}),

			web_search: tool({
				description:
					"Search the web for current information. Returns top results (title, URL, snippet) plus a short synthesized answer.",
				inputSchema: z.object({
					query: z.string().describe("The search query"),
					maxResults: z
						.number()
						.int()
						.min(1)
						.max(10)
						.optional()
						.describe("How many results to return (default 5)"),
				}),
				execute: async ({ query, maxResults }) => {
					const res = await fetch("https://api.tavily.com/search", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${this.env.TAVILY_API_KEY}`,
						},
						body: JSON.stringify({
							query,
							max_results: maxResults ?? 5,
							include_answer: true,
						}),
					});
					if (!res.ok) return `Web search failed (${res.status}).`;
					const data = (await res.json()) as {
						answer?: string;
						results?: { title: string; url: string; content: string }[];
					};
					return {
						answer: data.answer ?? null,
						results: (data.results ?? []).map((r) => ({
							title: r.title,
							url: r.url,
							snippet: r.content,
						})),
					};
				},
			}),

			send_image: tool({
				description:
					"Send an image to the current Telegram chat. Pass a direct image URL as `url`. To send a screenshot of a web page instead, pass the page URL as `url` and set `screenshot: true`.",
				inputSchema: z.object({
					url: z
						.string()
						.url()
						.describe("Image URL, or a web page URL when screenshot is true"),
					screenshot: z
						.boolean()
						.optional()
						.describe("Render the page at `url` and send a screenshot of it"),
					caption: z.string().optional().describe("Optional caption text"),
					fullPage: z
						.boolean()
						.optional()
						.describe("With screenshot, capture the full scrollable page"),
				}),
				execute: async ({ url, screenshot, caption, fullPage }) => {
					const chatId = this.telegramChatId();
					if (!chatId) return "No active Telegram chat to send a photo to.";

					const form = new FormData();
					form.set("chat_id", chatId);
					if (caption) form.set("caption", caption);
					if (screenshot) {
						const png = await this.captureScreenshot(url, fullPage ?? false);
						form.set(
							"photo",
							new Blob([png], { type: "image/png" }),
							"screenshot.png",
						);
					} else {
						form.set("photo", url);
					}
					return this.sendTelegramPhoto(form);
				},
			}),
		};
	}

	override getMessengers(): ThinkMessengers {
		return defineMessengers({
			telegram: telegramMessenger({
				token: this.env.TELEGRAM_BOT_TOKEN,
				userName: this.env.TELEGRAM_BOT_USERNAME,
				secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
				conversation: "self", // all chats share one memory; drop for per-thread
				respondTo: ["direct-message", "mention"],
			}),
		});
	}

	// Wipe the conversation AND the Chat SDK state sub-agents (each has its own
	// isolated SQLite, so clearing this agent alone wouldn't reach them).
	async resetEverything(): Promise<void> {
		for (const sub of this.listSubAgents(ThinkMessengerStateAgent)) {
			await this.deleteSubAgent(ThinkMessengerStateAgent, sub.name);
		}
		await this.clearMessages();
	}

	// BROWSER is typed as `BrowserRun`, but the browser tools and puppeteer
	// expect a `Fetcher` — same object at runtime.
	private get browserBinding(): Fetcher {
		return this.env.BROWSER as unknown as Fetcher;
	}

	// Chat SDK encodes thread ids as "telegram:<chatId>[:<topicId>]"; the API
	// needs the raw chatId.
	private telegramChatId(): string | undefined {
		const ctx = this.getMessengerContext();
		if (ctx?.provider !== "telegram") return undefined;
		return ctx.thread.providerThreadId.split(":")[1];
	}

	private async captureScreenshot(url: string, fullPage: boolean) {
		const browser = await puppeteer.launch(this.browserBinding);
		try {
			const page = await browser.newPage();
			await page.goto(url, { waitUntil: "networkidle0" });
			return await page.screenshot({ type: "png", fullPage });
		} finally {
			await browser.close();
		}
	}

	private async sendTelegramPhoto(form: FormData): Promise<string> {
		const res = await fetch(
			`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
			{ method: "POST", body: form },
		);
		return res.ok
			? "Photo sent to the chat."
			: `Telegram rejected the photo: ${await res.text()}`;
	}
}

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
				message: "Conversation and Chat SDK state cleared.",
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
