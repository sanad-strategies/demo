/**
 * Sanad website assistant on Cloudflare Workers AI (free plan).
 *
 * The website chat posts the conversation here. The worker asks a free Workers AI model for
 * the next reply. When the model decides the visitor is a real lead it ends its reply with a
 * HANDOVER line carrying the brief as JSON; the worker strips that line, alerts Mano (Telegram
 * or email, both free) and returns a WhatsApp link to Mano with the brief already written.
 */
import { SYSTEM_PROMPT } from "./prompt";

interface Env {
  AI: Ai;
  ALLOWED_ORIGINS: string;
  MANO_WHATSAPP: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_API?: string; // only for local testing against a mock
  RESEND_API_KEY?: string;
  ALERT_EMAIL?: string;
}

type Turn = { role: "user" | "assistant"; content: string };
type Lead = {
  customer_name: string; brand: string; needs: string; budget: string; timeline: string;
  contact: string; recommended_package: string; summary: string; urgent: boolean;
};

// A strong free model with good Arabic; Workers AI free plan has a daily allowance.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Cost and abuse limits
const MAX_USER_TURNS = 24;
const MAX_MESSAGE_CHARS = 1200;
const MAX_HISTORY_CHARS = 16000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 20; // per IP per minute, per worker instance

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

/** Pull the HANDOVER line out of the model's reply, if it wrote one. */
function splitHandover(raw: string): { reply: string; lead: Lead | null } {
  const m = raw.match(/\n?\s*HANDOVER:\s*(\{[\s\S]*\})\s*$/);
  if (!m) return { reply: raw.trim(), lead: null };
  const reply = raw.slice(0, m.index).trim();
  try {
    const d = JSON.parse(m[1]);
    const s = (v: unknown, dflt: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 400) : dflt);
    return {
      reply,
      lead: {
        customer_name: s(d.customer_name, "Unknown"),
        brand: s(d.brand, "Unknown"),
        needs: s(d.needs, "Not given"),
        budget: s(d.budget, "Not given"),
        timeline: s(d.timeline, "Not given"),
        contact: s(d.contact, "None"),
        recommended_package: s(d.recommended_package, "To confirm"),
        summary: s(d.summary, "See the conversation below."),
        urgent: d.urgent === true,
      },
    };
  } catch {
    return { reply, lead: null };
  }
}

function whatsappLink(env: Env, lead: Lead): string {
  const parts = [
    `Hi Mano, I'm ${lead.customer_name === "Unknown" ? "coming from your website" : lead.customer_name}.`,
    lead.brand !== "Unknown" ? `Brand: ${lead.brand}.` : "",
    lead.needs !== "Not given" ? `I need: ${lead.needs}.` : "",
    lead.budget !== "Not given" ? `Budget: ${lead.budget}.` : "",
    lead.timeline !== "Not given" ? `Timeline: ${lead.timeline}.` : "",
    lead.recommended_package !== "To confirm" ? `Your assistant suggested ${lead.recommended_package}.` : "",
  ].filter(Boolean);
  return `https://wa.me/${env.MANO_WHATSAPP}?text=${encodeURIComponent(parts.join(" "))}`;
}

async function alertMano(env: Env, lead: Lead, transcript: Turn[]): Promise<boolean> {
  const head = lead.urgent ? "URGENT · Sanad website" : "New lead · Sanad website";
  const text = [
    head, "",
    `Name: ${lead.customer_name}`, `Brand: ${lead.brand}`, `Needs: ${lead.needs}`,
    `Budget: ${lead.budget}`, `Timeline: ${lead.timeline}`, `Contact: ${lead.contact}`,
    `Suggested package: ${lead.recommended_package}`, "", lead.summary, "",
    "The visitor was given a button to message you on WhatsApp with this brief.",
  ].join("\n");
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

    let body: { messages?: unknown; handedOver?: unknown };
    try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400, headers); }
    const turns = validTurns(body.messages);
    if (!turns) return json({ error: "This conversation is too long or malformed. Please message us on WhatsApp." }, 400, headers);
    const alreadyHandedOver = body.handedOver === true;

    let raw: string;
    try {
      const out = (await env.AI.run(MODEL, {
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...turns],
        max_tokens: 450,
        temperature: 0.4,
      })) as { response?: string };
      raw = (out.response ?? "").trim();
    } catch (error) {
      // Most often the free daily allowance is used up; the widget then points to WhatsApp.
      console.error("Workers AI error", error);
      return json({ error: "The assistant is resting for today. Please message Mano directly on WhatsApp." }, 503, headers);
    }

    const { reply, lead } = splitHandover(raw);
    let handoff: { whatsapp: string; package: string; alerted: boolean } | null = null;
    if (lead && !alreadyHandedOver) {
      const alerted = await alertMano(env, lead, turns).catch(() => false);
      handoff = { whatsapp: whatsappLink(env, lead), package: lead.recommended_package, alerted };
    }
    return json({ reply: reply || "Could you tell me a bit more?", handoff }, 200, headers);
  },
};
