# Sanad website assistant

A small Cloudflare Worker behind the "Chat with us" window on the Sanad website. It answers
visitors with Cloudflare's free AI (Workers AI, free plan, no card). When the AI decides a visitor
is a real lead, it writes a hidden HANDOVER line; the worker turns it into an alert for Mano
(Telegram or email, both free) and a WhatsApp button to +20 155 568 9445 with the brief already written.

## Deploy

```bash
npm install
npx wrangler login              # free Cloudflare account, no card needed
# optional alert channel (free):
npx wrangler secret put TELEGRAM_BOT_TOKEN && npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler deploy
```

Then set `ASSISTANT_URL` in the chat widget to the deployed address
(`https://sanad-assistant.<account>.workers.dev`).

## Limits

- Workers AI free plan has a daily allowance. When it runs out, the chat tells visitors to
  message Mano on WhatsApp until the next day.
- Only pages on `ALLOWED_ORIGINS` can call it; 24 visitor messages per conversation,
  1,200 characters per message, 20 requests per minute per visitor.

The assistant's instructions live in `src/prompt.ts`.
