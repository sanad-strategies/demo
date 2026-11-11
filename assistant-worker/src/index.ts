/**
 * Sanad website assistant.
 *
 * The website chat widget posts the conversation here. This worker keeps the Claude key
 * secret, asks Claude for the next reply, and when Claude decides the visitor is a real
 * lead (by calling the hand_over_lead tool) it alerts Mano and returns a WhatsApp link
 * with the brief already written, so the visitor can continue with Mano directly.
 */
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt";

interface Env {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL?: string; // only for local testing against a mock
  ALLOWED_ORIGINS: string;
  MANO_WHATSAPP: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_API?: string; // only for local testing against a mock
  RESEND_API_KEY?: string;
  ALERT_EMAIL?: string;
}

type Turn = { role: "user" | "assistant"; content: string };

// Cost and abuse limits
const MAX_USER_TURNS = 24;
const MAX_MESSAGE_CHARS = 1200;
const MAX_HISTORY_CHARS = 16000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 20; // per IP per minute, per worker instance

const MODEL = "claude-opus-5-5";

const HAND_OVER_TOOL: Anthropic.Beta.BetaTool = {
  name: "hand_over_lead",
  description:
    "Hand a qualified lead over to Mano. Call this once you have the key details and the visitor wants to go ahead " +
    "(asks for a quote, to start, to talk to Mano), or immediately for complaints, payment questions or existing clients. " +
    "After it returns, tell the visitor to tap the WhatsApp button to continue with Mano.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["customer_name", "brand", "needs", "budget", "timeline", "contact", "recommended_package", "summary", "urgent"],
    properties: {
      customer_name: { type: "string", description: "The visitor's name, or \"Unknown\"." },
      brand: { type: "string", description: "Brand name and what they sell, or \"Unknown\"." },
      needs: { type: "string", description: "What they need: identity, photography, website, or a mix." },
      budget: { type: "string", description: "Budget as they stated it, or \"Not given\"." },
      timeline: { type: "string", description: "When they want it, or \"Not given\"." },
      contact: { type: "string", description: "Any contact detail or link they shared (Instagram, phone, email), or \"None\"." },
      recommended_package: { type: "string", description: "First Time Offer, Glow Up, From A to Success, or Custom." },
      summary: { type: "string", description: "Two or three sentences for Mano about the conversation, in English." },
      urgent: { type: "boolean", description: "True for complaints, payment issues or existing clients." },
    },
  },
};

type Lead = {
  customer_name: string; brand: string; needs: string; budget: string; timeline: string;
  contact: string; recommended_package: string; summary: string; urgent: boolean;
};

const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_MAX_REQUESTS;
}

function cors(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  const ok = origin && allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

function validTurns(input: unknown): Turn[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const turns: Turn[] = [];
  for (const t of input) {
    if (!t || (t.role !== "user" && t.role !== "assistant") || typeof t.content !== "string") return null;
    const content = t.content.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!content) return null;
    turns.push({ role: t.role, content });
  }
  if (turns[0].role !== "user" || turns[turns.length - 1].role !== "user") return null;
  for (let i = 1; i < turns.length; i++) if (turns[i].role === turns[i - 1].role) return null;
  if (turns.filter((t) => t.role === "user").length > MAX_USER_TURNS) return null;
  if (turns.reduce((n, t) => n + t.content.length, 0) > MAX_HISTORY_CHARS) return null;
  return turns;
}

function whatsappLink(env: Env, lead: Lead): string {
  const parts = [
    `Hi Mano, I'm ${lead.customer_name === "Unknown" ? "coming from your website" : lead.customer_name}.`,
    lead.brand !== "Unknown" ? `Brand: ${lead.brand}.` : "",
    `I need: ${lead.needs}.`,
    lead.budget !== "Not given" ? `Budget: ${lead.budget}.` : "",
    lead.timeline !== "Not given" ? `Timeline: ${lead.timeline}.` : "",
    `Your assistant suggested ${lead.recommended_package}.`,
  ].filter(Boolean);
  return `https://wa.me/${env.MANO_WHATSAPP}?text=${encodeURIComponent(parts.join(" "))}`;
}

async function alertMano(env: Env, lead: Lead, transcript: Turn[]): Promise<boolean> {
  const head = lead.urgent ? "URGENT · Sanad website" : "New lead · Sanad website";
  const lines = [
    head,
    "",
    `Name: ${lead.customer_name}`,
    `Brand: ${lead.brand}`,
    `Needs: ${lead.needs}`,
    `Budget: ${lead.budget}`,
    `Timeline: ${lead.timeline}`,
    `Contact: ${lead.contact}`,
    `Suggested package: ${lead.recommended_package}`,
    "",
    lead.summary,
    "",
    "The visitor was given a button to message you on WhatsApp with this brief.",
  ];
  const text = lines.join("\n");
  const convo = transcript.map((t) => `${t.role === "user" ? "Visitor" : "Assistant"}: ${t.content}`).join("\n\n");

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const r = await fetch(`${env.TELEGRAM_API ?? "https://api.telegram.org"}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `${text}\n\n— Conversation —\n${convo}`.slice(0, 4000) }),
    });
    return r.ok;
  }
  if (env.RESEND_API_KEY && env.ALERT_EMAIL) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Sanad Assistant <onboarding@resend.dev>",
        to: [env.ALERT_EMAIL],
        subject: `${head}: ${lead.customer_name} (${lead.recommended_package})`,
        text: `${text}\n\n--- Conversation ---\n${convo}`,
      }),
    });
    return r.ok;
  }
  return false;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const headers = cors(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/chat") return json({ error: "Not found" }, 404, headers);

    const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
    if (!origin || !allowed.includes(origin)) return json({ error: "Forbidden" }, 403, headers);
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (rateLimited(ip)) return json({ error: "Too many messages. Please wait a minute." }, 429, headers);

    let body: { messages?: unknown };
    try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400, headers); }
    const turns = validTurns(body.messages);
    if (!turns) return json({ error: "This conversation is too long or malformed. Please message us on WhatsApp." }, 400, headers);

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
    const messages: Anthropic.Beta.BetaMessageParam[] = turns.map((t) => ({ role: t.role, content: t.content }));
    let lead: Lead | null = null;
    let alerted = false;

    try {
      // At most one tool round: Claude may call hand_over_lead, then writes its closing line.
      for (let round = 0; round < 2; round++) {
        const response = await client.beta.messages.create({
          model: MODEL,
          max_tokens: 4000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "low" },
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: [HAND_OVER_TOOL],
          messages,
        });

        if (response.stop_reason === "refusal") {
          return json({ reply: "Sorry, I can't help with that here. You can message Mano directly on WhatsApp.", handoff: null }, 200, headers);
        }

        const toolUse = response.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (response.stop_reason === "tool_use" && toolUse && round === 0) {
          lead = toolUse.input as Lead;
          alerted = await alertMano(env, lead, turns).catch(() => false);
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "Handed over. A WhatsApp button with the brief is now shown to the visitor." }],
          });
          continue;
        }

        const reply = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return json({
          reply: reply || (lead ? "Mano will take it from here. Tap the button below to continue on WhatsApp." : "Could you tell me a bit more?"),
          handoff: lead ? { whatsapp: whatsappLink(env, lead), package: lead.recommended_package, alerted } : null,
        }, 200, headers);
      }
      return json({ reply: "Mano will take it from here. Tap the button below to continue on WhatsApp.", handoff: lead ? { whatsapp: whatsappLink(env, lead), package: lead.recommended_package, alerted } : null }, 200, headers);
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        return json({ error: "The assistant is busy. Please try again in a moment." }, 503, headers);
      }
      if (error instanceof Anthropic.APIError) {
        console.error(`Claude API error ${error.status}: ${error.message}`);
        return json({ error: "The assistant is unavailable right now. Please message us on WhatsApp." }, 502, headers);
      }
      console.error(error);
      return json({ error: "Something went wrong. Please message us on WhatsApp." }, 500, headers);
    }
  },
};
