import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { WorkspaceLike } from '@cloudflare/think';
import { sendTelegramFile } from './telegram';

export function getTools(deps: { env: Env; workspace: WorkspaceLike; getChatId: () => string | undefined }): ToolSet {
	return {
		web_search: tool({
			description: 'Search the web for current information. Returns top results (title, URL, snippet) plus a short synthesized answer.',
			inputSchema: z.object({
				query: z.string().describe('The search query'),
				maxResults: z.number().int().min(1).max(10).optional().describe('How many results to return (default 5)'),
			}),
			execute: async ({ query, maxResults }) => {
				const res = await fetch('https://api.tavily.com/search', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						authorization: `Bearer ${deps.env.TAVILY_API_KEY}`,
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
				"Send a file to the current Telegram chat. Set `source`: 'workspace' to send a file from your filesystem (give `path`), or 'url' to send a file straight from a public URL (give `url`). Images are shown inline; other types are sent as documents. Set `asDocument: true` to send an image uncompressed.",
			inputSchema: z.object({
				source: z.enum(['workspace', 'url']),
				path: z.string().optional().describe("Workspace file path, when source is 'workspace'"),
				url: z.string().url().optional().describe("File URL when source is 'url'"),
				caption: z.string().optional().describe('Optional caption text'),
				asDocument: z.boolean().optional().describe('Send an image as an uncompressed document'),
			}),
			execute: async ({ source, path, url, caption, asDocument }) => {
				const chatId = deps.getChatId();
				if (!chatId) return 'No active Telegram chat to send a file to.';

				let bytes: Uint8Array | undefined;
				let filename = 'file';
				if (source === 'workspace') {
					if (!path) return 'Provide the workspace path of the file to send.';
					const data = await deps.workspace.readFileBytes(path);
					if (!data) return `No file found at ${path}.`;
					bytes = data;
					filename = path.split('/').pop() || 'file';
				} else {
					if (!url) return 'Provide the file url to send.';
					filename = new URL(url).pathname.split('/').pop() || 'file';
				}

				const asPhoto = !asDocument && /\.(png|jpe?g|gif|webp)$/i.test(filename);
				const field = asPhoto ? 'photo' : 'document';

				const form = new FormData();
				form.set('chat_id', chatId);
				if (caption) form.set('caption', caption);
				if (bytes) form.set(field, new Blob([bytes]), filename);
				else form.set(field, url!);

				return sendTelegramFile(deps.env.TELEGRAM_BOT_TOKEN, asPhoto ? 'sendPhoto' : 'sendDocument', form);
			},
		}),
	};
}
