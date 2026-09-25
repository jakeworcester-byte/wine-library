// "Ask Jake" chat relay. The static site POSTs the conversation here; this
// Worker adds the house rules and the live cellar list, calls Claude, and
// streams plain text back. The API key never leaves Cloudflare.
import Anthropic from "@anthropic-ai/sdk";
import { HOUSE_RULES, cellarBlock } from "./prompt.js";

const MAX_TURNS = 12;          // messages in one conversation (user + assistant)
const MAX_USER_CHARS = 600;
const MAX_ASSISTANT_CHARS = 4000;
const CELLAR_TTL_MS = 5 * 60 * 1000;

let cellarCache = { at: 0, data: null };

async function loadCellar(env) {
  if (cellarCache.data && Date.now() - cellarCache.at < CELLAR_TTL_MS) return cellarCache.data;
  const res = await fetch(env.WINES_URL, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error(`wines.json ${res.status}`);
  cellarCache = { at: Date.now(), data: await res.json() };
  return cellarCache.data;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function reply(status, text, headers) {
  return new Response(text, { status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
}

// Accepts [{role: "user"|"assistant", content: string}, ...], alternating and
// ending on a user turn. Returns a cleaned copy, or null if it doesn't fit.
function validMessages(body) {
  const msgs = body && body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0 || msgs.length > MAX_TURNS) return null;
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const role = i % 2 === 0 ? "user" : "assistant";
    if (!m || m.role !== role || typeof m.content !== "string") return null;
    const text = m.content.trim();
    const limit = role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS;
    if (!text || text.length > limit) return null;
    out.push({ role, content: text });
  }
  return out[out.length - 1].role === "user" ? out : null;
}

export default {
  async fetch(request, env, ctx) {
    const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
    const origin = request.headers.get("Origin") || "";
    if (!allowed.includes(origin)) return new Response("Forbidden", { status: 403 });
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return reply(405, "Method not allowed", cors);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const [visitor, site] = await Promise.all([
      env.PER_VISITOR.limit({ key: ip }),
      env.SITE_WIDE.limit({ key: "all" }),
    ]);
    if (!visitor.success || !site.success) {
      return reply(429, "Easy there. Give me a minute to catch up, then ask again.", cors);
    }

    let messages;
    try {
      messages = validMessages(await request.json());
    } catch {
      messages = null;
    }
    if (!messages) return reply(400, "That question didn't come through right. Try a shorter one.", cors);

    let cellar;
    try {
      cellar = await loadCellar(env);
    } catch (err) {
      console.error("cellar load failed", err);
      return reply(503, "I can't see the cellar list right now. Try again in a minute.", cors);
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const stream = client.messages.stream({
      model: env.MODEL,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: [
        { type: "text", text: HOUSE_RULES },
        { type: "text", text: cellarBlock(cellar, new Date().getUTCFullYear()), cache_control: { type: "ephemeral" } },
      ],
      messages,
    });

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    ctx.waitUntil((async () => {
      let wrote = false;
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            wrote = true;
            await writer.write(enc.encode(event.delta.text));
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal" && !wrote) {
          await writer.write(enc.encode("I'm going to pass on that one. Ask me about wine instead."));
        }
        const u = final.usage;
        console.log(JSON.stringify({
          model: env.MODEL, stop: final.stop_reason, in: u.input_tokens, out: u.output_tokens,
          cache_read: u.cache_read_input_tokens, cache_write: u.cache_creation_input_tokens,
        }));
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError) {
          console.error("anthropic rate limit", err.status);
        } else if (err instanceof Anthropic.APIError) {
          console.error("anthropic api error", err.status, err.message);
        } else {
          console.error("stream failed", err);
        }
        await writer.write(enc.encode(wrote
          ? "\n\n(Lost my train of thought there. Ask again?)"
          : "Something went sideways on my end. Try again in a minute."));
      } finally {
        await writer.close();
      }
    })());

    return new Response(readable, {
      headers: { ...cors, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  },
};
