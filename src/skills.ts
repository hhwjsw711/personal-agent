import { skills } from "@cloudflare/think";

// Skill catalog. `description` is the one-line hint the model sees every turn;
// `body` is the full instruction set, loaded only when the model activates it.
export const skillSources = [
	skills.fromManifest({
		id: "local",
		fingerprint: "1", // bump when a skill's text changes
		skills: [
			{
				name: "bookmark",
				description:
					"Bookmark a web page as a readable Markdown note: read the page, write a clean summary to the workspace, and send the file to the chat. Use when the user shares a URL to bookmark, save, summarize, or send as a file.",
				body: [
					"# Bookmark a webpage",
					"",
					"Turn a web page into a clean Markdown note in your workspace, then send it to the chat.",
					"",
					"1. Read the page with your browser tools (`browser_search` / `browser_execute`): load the URL and extract the main text — title, date/author if present, and body. Skip nav, ads, and comments.",
					"2. Write `bookmarks/<slug>.md` with the built-in `write` tool: a `# Title` heading, a one-line source link, then a concise summary (key points as bullets) plus any important detail. Derive `<slug>` from the title (lowercase, hyphenated).",
					'3. Send it: call `send_file` with `source: "workspace"` and `path: "bookmarks/<slug>.md"`, plus a short caption naming the article.',
					"",
					"If the page can't be read, say so briefly instead of guessing.",
				].join("\n"),
			},
		],
	}),
];
