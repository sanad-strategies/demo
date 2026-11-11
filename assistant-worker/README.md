# Sanad website assistant

A small Cloudflare Worker behind the "Chat with us" window on sanad-strategies.com.
It keeps the Claude API key private, asks Claude for each reply, and when Claude decides a
visitor is a real lead it alerts Mano and gives the visitor a WhatsApp button (to +20 155 568 9445)
with the brief already written.

## Deploy

```bash
npm install
npx wrangler login                       # Cloudflare account
npx wrangler secret put ANTHROPIC_API_KEY
# one alert channel:
npx wrangler secret put TELEGRAM_BOT_TOKEN && npx wrangler secret put TELEGRAM_CHAT_ID
#   or
npx wrangler secret put RESEND_API_KEY && npx wrangler secret put ALERT_EMAIL
npx wrangler deploy
```

Then set `ASSISTANT_URL` in the chat widget (in `gallery.html` / the site's `index.html`) to the
deployed address, e.g. `https://sanad-assistant.<account>.workers.dev`.

## Limits

- Only pages on `ALLOWED_ORIGINS` can call it.
- 24 visitor messages per conversation, 1,200 characters per message, 20 requests per minute per visitor.
- Claude Opus 5.5 at low effort; the hand-over happens once per conversation.

The assistant's instructions live in `src/prompt.ts`.
