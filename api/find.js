// Gift Scout — the "agent" behind the page.
// Steps: 1) plan searches  2) Tavily searches the web (+ Tavily's AI answer)  3) score and pick the best 3.
// Keys live in Vercel environment variables, never in the page:
//   TAVILY_API_KEY  (required for real results)
//   XAI_API_KEY     (optional: Grok for planning + picking)
//   XAI_MODEL       (optional, defaults to grok-4)

const TAVILY_URL = "https://api.tavily.com/search";
const XAI_URL = "https://api.x.ai/v1/chat/completions";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const body = typeof req.body === "string" ? safeJson(req.body) : req.body || {};
  const request = String(body.request || "").trim().slice(0, 500);
  if (!request) return res.status(400).json({ error: "Tell me who the gift is for." });

  const steps = [];
  try {
    const result = await findGifts(request, steps, process.env);
    return res.status(200).json({ ...result, steps });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong finding gifts. Try again in a moment.", steps });
  }
}

export async function findGifts(request, steps, env) {
  const tavilyKey = env.TAVILY_API_KEY;
  const xaiKey = env.XAI_API_KEY;
  const model = env.XAI_MODEL || "grok-4";

  if (!tavilyKey) {
    steps.push("No TAVILY_API_KEY set, so showing demo results");
    return { mode: "demo", gifts: demoGifts() };
  }

  // Step 1: plan searches (Grok if available, otherwise built-in rules)
  const budget = parseBudget(request);
  let queries = [
    `best gift for ${request}`,
    `buy ${request} gift online UK`,
    `unique present ${request} shop`,
  ];
  if (xaiKey) {
    steps.push("Grok is working out what to search for");
    const plan = await askGrok(xaiKey, model, [
      { role: "system", content: "You are a UK gift-shopping agent. Return JSON only." },
      { role: "user", content: `Shopper request: "${request}"\nWrite 3 different, specific web search queries to find real products to buy online in the UK. Return {"queries":["...","...","..."]}` },
    ]).catch(() => null);
    if (plan?.queries?.length) queries = plan.queries.slice(0, 3).map(String);
  } else {
    steps.push(`Understood the request${budget ? ` (budget about £${budget})` : ""} and planned 3 searches`);
  }
  steps.push(`Running ${queries.length} searches across UK shops`);

  // Step 2: search the web (first search also asks Tavily's AI for advice)
  const searches = await Promise.all(
    queries.map((q, i) =>
      tavilySearch(tavilyKey, q, i === 0 ? `What are 3 great specific gift products to buy in the UK for: ${request}? Keep it brief.` : null).catch(() => ({ results: [] }))
    )
  );
  const advice = searches[0].answer || null;
  const seen = new Set();
  const results = searches
    .flatMap((s) => s.results || [])
    .filter((r) => r.url && !SOCIAL.test(hostOf(r.url)) && !seen.has(r.url) && seen.add(r.url));
  steps.push(`Read ${results.length} pages from across the web`);
  if (!results.length) return { mode: "live", advice, gifts: [] };

  // Step 3: pick the best 3
  if (xaiKey) {
    steps.push("Grok is comparing options and choosing the best 3");
    const list = results.slice(0, 15).map((r, i) => `[${i}] ${r.title}\n${r.url}\n${(r.content || "").slice(0, 300)}`).join("\n\n");
    const pick = await askGrok(xaiKey, model, [
      { role: "system", content: "You are a thoughtful UK gift-shopping agent. Only use the search results given. Return JSON only." },
      { role: "user", content: `Shopper request: "${request}"\n\nSearch results:\n${list}\n\nPick the 3 best specific products (prefer real product pages, respect the budget). Return {"gifts":[{"index":number,"name":"short product name","price":"£xx or null","reason":"one warm sentence on why it fits"}]}` },
    ]).catch(() => null);
    const gifts = (pick?.gifts || []).filter((g) => results[g.index]).slice(0, 3).map((g) => ({
      name: g.name || results[g.index].title,
      price: g.price && g.price !== "null" ? g.price : null,
      reason: g.reason || "",
      url: results[g.index].url,
    }));
    if (gifts.length) { steps.push("Done"); return { mode: "agent", advice, gifts }; }
  }

  steps.push("Scored every page: real shops over blog lists, within budget, different stores");
  const gifts = rankResults(results, budget).slice(0, 3);
  steps.push("Done");
  return { mode: "tavily", advice, gifts };
}

const SHOPS = /amazon\.co\.uk|etsy\.com|johnlewis|notonthehighstreet|argos|ebay\.co\.uk|boots\.com|waterstones|firebox|menkind|lakeland|selfridges|next\.co\.uk|marksandspencer|lookfantastic|currys|hobbycraft|smythstoys|hamleys|decathlon|very\.co\.uk|wilko|superdrug|cultbeauty|prezzybox|iwoot|zavvi|thetoyshop|garden|shop|store/i;
const PRODUCT_PATH = /\/(dp|p|product|products|item|itm|listing|gp\/product)\/|\/[a-z0-9-]+-p\d+|prd|sku/i;
const SOCIAL = /facebook|instagram|tiktok|twitter|x\.com|pinterest|youtube|reddit|linkedin|quora/i;
const LISTICLE = /\b(best|ideas|guide|top \d+|\d+ (gifts|presents)|review|blog|reddit)\b/i;

function parseBudget(text) {
  const m = String(text).match(/[£$€]\s?(\d+(?:\.\d+)?)/) || String(text).match(/(\d+)\s?(?:pounds|quid|gbp)/i);
  return m ? Math.round(Number(m[1])) : null;
}

function findPrice(text) {
  const m = String(text || "").match(/[£$]\s?(\d{1,4}(?:\.\d{2})?)/);
  return m ? Number(m[1]) : null;
}

function rankResults(results, budget) {
  const scored = results.map((r) => {
    const host = hostOf(r.url);
    const text = `${r.title} ${r.content || ""}`;
    const price = findPrice(text);
    let score = r.score || 0;
    if (SHOPS.test(host)) score += 1;
    if (PRODUCT_PATH.test(r.url)) score += 1.5;
    if (/father'?s day|for sale|gifts for|presents/i.test(r.title) && !PRODUCT_PATH.test(r.url)) score -= 0.8;
    if (LISTICLE.test(r.title) || /\/blog|\/ideas|\/guide|reddit/.test(r.url)) score -= 1.2;
    if (price != null) score += 0.5;
    if (budget && price != null) score += price <= budget * 1.1 ? 0.8 : -1.5;
    return { r, host, price, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const out = [], hosts = new Set();
  for (const pass of [true, false]) {
    for (const s of scored) {
      if (out.length >= 3) break;
      if (out.includes(s) || (pass && hosts.has(s.host))) continue;
      out.push(s); hosts.add(s.host);
    }
  }
  return out.map(({ r, price }) => ({
    name: cleanTitle(r.title),
    price: price != null ? `£${price}` : null,
    reason: firstSentence(r.content),
    url: r.url,
  }));
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }
function cleanTitle(t) { return String(t || "Gift").split(/ [|–-] (?=[^|–-]*$)/)[0].slice(0, 90); }
function firstSentence(t) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  const m = s.match(/^.{20,180}?[.!?](\s|$)/);
  return m ? m[0].trim() : s.slice(0, 160) + (s.length > 160 ? "…" : "");
}

async function tavilySearch(key, query, answerQuestion) {
  const r = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query: answerQuestion || query,
      max_results: 8,
      search_depth: "advanced",
      country: "united kingdom",
      include_answer: answerQuestion ? "advanced" : false,
    }),
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}`);
  return r.json();
}

async function askGrok(key, model, messages) {
  const r = await fetch(XAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.4, response_format: { type: "json_object" } }),
  });
  if (!r.ok) throw new Error(`Grok ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return safeJson(data.choices?.[0]?.message?.content || "");
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
  }
}

function demoGifts() {
  return [
    { name: "Personalised leather tackle wallet", price: "£34", reason: "Demo result: add your Tavily key in Vercel to see real products.", url: "https://tavily.com" },
    { name: "Waterproof fishing flask set", price: "£28", reason: "Demo result: practical for long mornings on the riverbank.", url: "https://tavily.com" },
    { name: "Fly-tying starter kit", price: "£39", reason: "Demo result: a new hobby within the hobby.", url: "https://tavily.com" },
  ];
}
