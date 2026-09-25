// "Ask Jake" chat relay. The static site POSTs the conversation here; this
// Worker adds the house rules and the live cellar list, calls Claude, and
// streams plain text back. The API key never leaves Cloudflare.
import Anthropic from "@anthropic-ai/sdk";
import { HOUSE_RULES, cellarBlock, palateBlock } from "./prompt.js";

const MAX_TURNS = 12;          // messages in one conversation (user + assistant)
const MAX_USER_CHARS = 600;
const MAX_ASSISTANT_CHARS = 4000;
const CELLAR_TTL_MS = 5 * 60 * 1000;
const MAX_CONTINUATIONS = 2;   // resumes after a server-side pause_turn
const SEARCHING = "\u001e";   // in-band marker: the page shows "checking the shelves"

// Web search for "what should I buy" questions, localized to Kansas City.
const WEB_SEARCH = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 3,
  user_location: { type: "approximate", city: "Kansas City", region: "Missouri", country: "US", timezone: "America/Chicago" },
};

let dataCache = { at: 0, cellar: null, palate: null };

async function getJson(url) {
  const res = await fetch(url, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

async function loadData(env) {
  if (dataCache.cellar && Date.now() - dataCache.at < CELLAR_TTL_MS) return dataCache;
  const [cellar, palate] = await Promise.all([
    getJson(env.WINES_URL),
    getJson(env.PALATE_URL).catch((err) => {
      console.error("palate load failed", err);
      return null;   // the chat still works for cellar questions
    }),
  ]);
  dataCache = { at: Date.now(), cellar, palate };
  return dataCache;
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

// Writes one anonymous row per question. Never blocks or breaks the chat.
async function logQuestion(env, { chatId, messages, shown, log }) {
  if (!env.LOG) return;
  try {
    await env.LOG.prepare(
      `INSERT INTO questions (at, convo, turn, question, answer, searches, model,
         in_tokens, cache_read, cache_write, out_tokens, stop, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      new Date().toISOString(),
      chatId,
      Math.ceil(messages.length / 2),
      messages[messages.length - 1].content,
      shown.trim().slice(0, 4000) || null,
      log.searches, env.MODEL, log.in, log.cacheRead, log.cacheWrite, log.out, log.stop, log.error,
    ).run();
  } catch (err) {
    console.error("question log failed", err);
  }
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
    let chatId = null;
    try {
      const body = await request.json();
      messages = validMessages(body);
      if (typeof body.convo === "string" && /^[a-z0-9]{8,32}$/.test(body.convo)) chatId = body.convo;
    } catch {
      messages = null;
    }
    if (!messages) return reply(400, "That question didn't come through right. Try a shorter one.", cors);

    let data;
    try {
      data = await loadData(env);
    } catch (err) {
      console.error("cellar load failed", err);
      return reply(503, "I can't see the cellar list right now. Try again in a minute.", cors);
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const system = [
      { type: "text", text: HOUSE_RULES },
      { type: "text", text: palateBlock(data.palate) || "TASTING RECORD unavailable right now." },
      { type: "text", text: cellarBlock(data.cellar, new Date().getUTCFullYear()), cache_control: { type: "ephemeral" } },
    ];

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    ctx.waitUntil((async () => {
      let wrote = false;
      let convo = messages;
      // For the question log: what the guest ends up seeing (text after the last
      // search, same as the page shows) and usage summed across continuations.
      let shown = "";
      const log = { searches: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, stop: null, error: null };
      // If the guest closes the chat mid-answer, writes start failing. Stop
      // writing, stop paying for the rest of the answer, and still log it.
      let guestLeft = false;
      const send = async (text) => {
        if (guestLeft) return;
        try {
          await writer.write(enc.encode(text));
        } catch {
          guestLeft = true;
        }
      };
      try {
        for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
          const stream = client.messages.stream({
            model: env.MODEL,
            max_tokens: 3000,
            thinking: { type: "adaptive" },
            output_config: { effort: "low" },
            system,
            tools: [WEB_SEARCH],
            messages: convo,
          });
          for await (const event of stream) {
            if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") {
              shown = "";
              await send(SEARCHING);
            } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              wrote = true;
              shown += event.delta.text;
              await send(event.delta.text);
            }
            if (guestLeft) {
              stream.abort();
              break;
            }
          }
          if (guestLeft) {
            log.error = "guest closed the chat before the answer finished";
            break;
          }
          const final = await stream.finalMessage();
          const u = final.usage;
          log.in += u.input_tokens || 0;
          log.out += u.output_tokens || 0;
          log.cacheRead += u.cache_read_input_tokens || 0;
          log.cacheWrite += u.cache_creation_input_tokens || 0;
          log.searches += u.server_tool_use ? u.server_tool_use.web_search_requests || 0 : 0;
          log.stop = final.stop_reason;
          if (final.stop_reason === "refusal" && !wrote) {
            shown = "I'm going to pass on that one. Ask me about wine instead.";
            await send(shown);
          }
          // A long search can pause server-side; send the partial turn back to resume it.
          if (final.stop_reason !== "pause_turn") break;
          convo = [...convo, { role: "assistant", content: final.content }];
        }
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError) {
          console.error("anthropic rate limit", err.status);
        } else if (err instanceof Anthropic.APIError) {
          console.error("anthropic api error", err.status, err.message);
        } else {
          console.error("stream failed", err);
        }
        log.error = String((err && err.message) || err).slice(0, 300);
        await send(wrote
          ? "\n\n(Lost my train of thought there. Ask again?)"
          : "Something went sideways on my end. Try again in a minute.");
      } finally {
        try {
          await writer.close();
        } catch {
          // guest already gone
        }
        await logQuestion(env, { chatId, messages, shown, log });
      }
    })());

    return new Response(readable, {
      headers: { ...cors, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  },
};
