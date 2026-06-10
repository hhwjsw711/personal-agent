# personal-agent

A deliberately minimal AI agent on Cloudflare Workers, built on [Think](https://developers.cloudflare.com/agents/harnesses/think/) (Agents SDK) and reachable from Telegram.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/megaconfidence/personal-agent)

It's a thin skeleton — one `PersonalAgent` class plus a small Worker entry in `src/index.ts` (~250 lines). It's meant to be read, trimmed, and extended: tools are a few lines each and the model discovers them from their descriptions. Keep what you need, delete what you don't, add your own.

## Capabilities

- **Telegram chat** with persistent per-conversation memory (Durable Object SQLite).
- **Web search** via Tavily — `web_search`.
- **Web browsing** via Chrome DevTools / Browser Run — `browser_search`, `browser_execute`.
- **Send files** — send any file from the workspace, a public URL, or a live page screenshot to the chat (`send_file`).
- **Smart home** — control Home Assistant devices over MCP.
- **Workspace tools** — files + sandboxed bash, built into Think.
- **Skills** — on-demand playbooks the model activates per task; ships with `bookmark` (`getSkills()`).

> Want another capability? Add a `tool()` in `getTools()`, or another MCP server in `configureSession()`. Don't need one? Delete its few lines.

## Setup

Needs a Cloudflare account and Node. Run `npm install`, then create a `.env` (gitignored) with the secrets for the pieces you want.

<details>
<summary><b>Telegram</b> — the chat channel (required)</summary>

1. Create a bot with [@BotFather](https://t.me/BotFather); copy the **token** and **username**.
2. Add to `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_BOT_USERNAME=your_bot          # without the @
   TELEGRAM_WEBHOOK_SECRET_TOKEN=any-long-random-string
   ```
3. Register the webhook by opening `https://<your-url>/setup` once (see **Run** / **Deploy**).

The bot replies to direct messages and @mentions. Edit `getSystemPrompt()` to change its personality.
</details>

<details>
<summary><b>Workers AI</b> — the model</summary>

Already wired through the `AI` binding (`getModel()` → `@cf/moonshotai/kimi-k2.6`). No key, but run `npx wrangler login` — the binding runs against your account even in local dev. Swap the model string in `getModel()` to use a different one.
</details>

<details>
<summary><b>Web search</b> — Tavily</summary>

1. Get a key at [tavily.com](https://tavily.com).
2. Add to `.env`: `TAVILY_API_KEY=tvly-...`
</details>

<details>
<summary><b>Browser & screenshots</b> — Browser Run</summary>

No keys. Uses the `BROWSER` and `LOADER` (Worker Loader) bindings already in `wrangler.jsonc`; `wrangler dev` provisions a browser automatically. Just needs Browser Run available on your account.
</details>

<details>
<summary><b>Home Assistant</b> — smart home (optional)</summary>

1. In Home Assistant, add the **Model Context Protocol Server** integration and **expose** the devices you want to Assist.
2. Create a **Long-Lived Access Token** (Profile → Security).
3. HA must be reachable over **public HTTPS** (Nabu Casa or a Cloudflare Tunnel) — LAN addresses are blocked.
4. Add to `.env`:
   ```
   HA_MCP_URL=https://<your-home-assistant>/api/mcp
   HA_TOKEN=<long-lived access token>
   ```
</details>

## Run locally

<details>
<summary>Start the dev server + tunnel</summary>

```sh
npm run dev
```

This starts the Worker and a Cloudflare Quick Tunnel, printing a public `https://<name>.trycloudflare.com` URL. Open `https://<name>.trycloudflare.com/setup` once to point Telegram at it, then DM your bot.

Quick Tunnel URLs are ephemeral — if it changes, just open `/setup` again.
</details>

## Deploy

Use the **Deploy to Cloudflare** button above for one-click setup — it clones the repo, provisions the Durable Object and Workers AI, and prompts for the secrets listed in `.env.example`. Or deploy from the CLI:

<details>
<summary>Deploy to a stable workers.dev URL</summary>

Set each secret, then deploy:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_BOT_USERNAME
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET_TOKEN
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put HA_MCP_URL
npx wrangler secret put HA_TOKEN
npm run deploy
```

Then open `https://personal-agent.<your-subdomain>.workers.dev/setup`.

> All six are listed in `secrets.required` (`wrangler.jsonc`), so deploy fails if any is missing — drop the ones for capabilities you removed.
>
> `/setup` and `/reset` are unauthenticated — add a guard (e.g. a secret query param) before exposing them publicly.
</details>

## Routes

| Route | Purpose |
| --- | --- |
| `GET /setup` | Register the Telegram webhook at the current host. |
| `GET /reset` | Wipe the conversation and Chat SDK state. |
| `/messengers/telegram/webhook` | Telegram delivery (set automatically by `/setup`). |

## Extend it

- **Add a tool** → a `tool({ description, inputSchema, execute })` entry in `getTools()`.
- **Add a service** → another `addMcpServer(...)` in `configureSession()`.
- **Per-chat memory** → remove `conversation: "self"` in `getMessengers()`.
- **Another channel** → add an adapter (Slack, Discord, …) beside `telegram`.

After changing bindings in `wrangler.jsonc`, run `npm run cf-typegen`.
