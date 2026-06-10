import { getAgentByName, routeAgentRequest } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import {
	Think,
	type Session,
	type TurnContext,
	type ToolCallContext,
} from "@cloudflare/think";
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
import { skillSources } from "./skills";

// Backs Chat SDK state; the framework routes to it as a sub-agent.
export { ThinkMessengerStateAgent };

const TELEGRAM_WEBHOOK_PATH = "/messengers/telegram/webhook";

export class PersonalAgent extends Think<Env> {
	// Connect Home Assistant's MCP tools before the first turn runs.
	waitForMcpConnections = true;

	// The live "progress" message for the current messenger turn.
	private status?: { chatId: string; messageId: number; text: string };

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

			send_file: tool({
				description:
					"Send a file to the current Telegram chat. Set `source`: 'workspace' to send a file from your filesystem (give `path`), 'url' to send a file straight from a public URL (give `url`), or 'screenshot' to render a web page and send a PNG of it (give the page `url`). Images and screenshots are shown inline; other types are sent as documents. Set `asDocument: true` to send an image uncompressed.",
				inputSchema: z.object({
					source: z.enum(["workspace", "url", "screenshot"]),
					path: z
						.string()
						.optional()
						.describe("Workspace file path, when source is 'workspace'"),
					url: z
						.string()
						.url()
						.optional()
						.describe(
							"File URL when source is 'url', or page URL when 'screenshot'",
						),
					caption: z.string().optional().describe("Optional caption text"),
					fullPage: z
						.boolean()
						.optional()
						.describe("With screenshot, capture the full scrollable page"),
					asDocument: z
						.boolean()
						.optional()
						.describe("Send an image as an uncompressed document"),
				}),
				execute: async ({ source, path, url, caption, fullPage, asDocument }) => {
					const chatId = this.telegramChatId();
					if (!chatId) return "No active Telegram chat to send a file to.";

					let bytes: Uint8Array | undefined;
					let filename = "file";
					if (source === "screenshot") {
						if (!url) return "Provide the page url to screenshot.";
						bytes = await this.captureScreenshot(url, fullPage ?? false);
						filename = "screenshot.png";
					} else if (source === "workspace") {
						if (!path) return "Provide the workspace path of the file to send.";
						const data = await this.workspace.readFileBytes(path);
						if (!data) return `No file found at ${path}.`;
						bytes = data;
						filename = path.split("/").pop() || "file";
					} else {
						if (!url) return "Provide the file url to send.";
						filename = new URL(url).pathname.split("/").pop() || "file";
					}

					const asPhoto =
						!asDocument &&
						(source === "screenshot" || /\.(png|jpe?g|gif|webp)$/i.test(filename));
					const field = asPhoto ? "photo" : "document";

					const form = new FormData();
					form.set("chat_id", chatId);
					if (caption) form.set("caption", caption);
					// With bytes we upload the file; otherwise Telegram fetches the URL.
					if (bytes) form.set(field, new Blob([bytes]), filename);
					else form.set(field, url!);

					return this.sendTelegramFile(asPhoto ? "sendPhoto" : "sendDocument", form);
				},
			}),
		};
	}

	override getSkills() {
		return skillSources;
	}

	// Show live progress while a turn runs: post a status message on the first
	// tool call, edit it as each subsequent tool runs, then delete it once the
	// final answer is delivered. Telegram can't render tool-call parts like a
	// custom UI, so we translate each tool event into one line.
	override async beforeTurn(ctx: TurnContext) {
		if (!ctx.continuation && this.telegramChatId()) this.status = undefined;
	}

	override async beforeToolCall(ctx: ToolCallContext) {
		const chatId = this.telegramChatId();
		if (!chatId) return;
		const text = `⏳ Running ${ctx.toolName}…`;
		if (this.status) {
			if (this.status.text === text) return;
			await this.callTelegram("editMessageText", {
				chat_id: chatId,
				message_id: this.status.messageId,
				text,
			});
			this.status.text = text;
		} else {
			const res = await this.callTelegram("sendMessage", {
				chat_id: chatId,
				text,
			});
			const data = (await res.json()) as { result?: { message_id: number } };
			if (data.result)
				this.status = { chatId, messageId: data.result.message_id, text };
		}
	}

	override async onChatResponse() {
		if (!this.status) return;
		await this.callTelegram("deleteMessage", {
			chat_id: this.status.chatId,
			message_id: this.status.messageId,
		});
		this.status = undefined;
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

	// Wipe everything: the conversation, the workspace files, and the Chat SDK
	// state sub-agents (each has its own isolated SQLite, so clearing this agent
	// alone wouldn't reach them).
	async resetEverything(): Promise<void> {
		for (const sub of this.listSubAgents(ThinkMessengerStateAgent)) {
			await this.deleteSubAgent(ThinkMessengerStateAgent, sub.name);
		}
		for (const entry of await this.workspace.readDir("/")) {
			await this.workspace.rm(entry.path, { recursive: true, force: true });
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

	private async sendTelegramFile(
		method: "sendPhoto" | "sendDocument",
		form: FormData,
	): Promise<string> {
		const res = await fetch(
			`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${method}`,
			{ method: "POST", body: form },
		);
		return res.ok
			? "File sent to the chat."
			: `Telegram rejected the file: ${await res.text()}`;
	}

	// JSON Bot API call for text-only methods (sendMessage/editMessageText/
	// deleteMessage); file uploads use sendTelegramFile (multipart) instead.
	private callTelegram(method: string, body: Record<string, unknown>) {
		return fetch(
			`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${method}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		);
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
