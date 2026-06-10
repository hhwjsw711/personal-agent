import type { MessengerContext } from "@cloudflare/think/messengers";

// Chat SDK encodes thread ids as "telegram:<chatId>[:<topicId>]"; the Bot API
// needs the raw chatId.
export function decodeChatId(
	ctx: MessengerContext | undefined,
): string | undefined {
	if (ctx?.provider !== "telegram") return undefined;
	return ctx.thread.providerThreadId.split(":")[1];
}

// JSON Bot API call for text-only methods (sendMessage/editMessageText/
// deleteMessage); file uploads use sendTelegramFile (multipart) instead.
export function callTelegram(
	token: string,
	method: string,
	body: Record<string, unknown>,
) {
	return fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

export async function sendTelegramFile(
	token: string,
	method: "sendPhoto" | "sendDocument",
	form: FormData,
): Promise<string> {
	const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		body: form,
	});
	return res.ok
		? "File sent to the chat."
		: `Telegram rejected the file: ${await res.text()}`;
}
