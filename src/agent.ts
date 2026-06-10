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
import { getTools } from "./tools";
import { skillSources } from "./skills";
import { mcpServers } from "./mcps";
import { callTelegram, decodeChatId } from "./telegram";

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

	// Connect each configured MCP server; their tools merge into every turn.
	override async configureSession(session: Session): Promise<Session> {
		for (const server of mcpServers(this.env)) {
			try {
				const result = await this.addMcpServer(
					server.name,
					server.url,
					server.options,
				);
				if (result.state !== "ready") {
					console.error(`MCP server "${server.name}" not ready:`, result);
				}
			} catch (err) {
				console.error(`MCP server "${server.name}" connection failed:`, err);
			}
		}
		return session;
	}

	override getTools() {
		return getTools({
			env: this.env,
			browser: this.browserBinding,
			workspace: this.workspace,
			getChatId: () => this.telegramChatId(),
		});
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
			await callTelegram(this.env.TELEGRAM_BOT_TOKEN, "editMessageText", {
				chat_id: chatId,
				message_id: this.status.messageId,
				text,
			});
			this.status.text = text;
		} else {
			const res = await callTelegram(this.env.TELEGRAM_BOT_TOKEN, "sendMessage", {
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
		await callTelegram(this.env.TELEGRAM_BOT_TOKEN, "deleteMessage", {
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

	private telegramChatId(): string | undefined {
		return decodeChatId(this.getMessengerContext());
	}
}
