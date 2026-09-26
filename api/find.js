// Gift Scout — the "agent" behind the page.
// Steps: 1) AI plans searches  2) Tavily searches the web  3) AI picks the best 3 gifts.
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

  // Step 1: plan searches
  let queries = [`${request} gift buy UK`];
  if (xaiKey) {
    steps.push("Grok is working out what to search for");
    const plan = await askGrok(xaiKey, model, [
      { role: "system", content: "You are a UK gift-shopping agent. Return JSON only." },
      {
        role: "user",
        content: `Shopper request: "${request}"\nWrite 3 different, specific web search queries to find real products to buy online in the UK that fit the person, interests and budget. Return {"queries":["...","...","..."],"budget_gbp":number|null}`,
      },
    ]).catch(() => null);
    if (plan?.queries?.length) queries = plan.queries.slice(0, 3).map(String);
  }
  steps.push(`Searching: ${queries.map((q) => `"${q}"`).join(", ")}`);

  // Step 2: search the web
  const searches = await Promise.all(queries.map((q) => tavilySearch(tavilyKey, q).catch(() => [])));
  const seen = new Set();
  const results = searches.flat().filter((r) => r.url && !seen.has(r.url) && seen.add(r.url));
  steps.push(`Found ${results.length} candidate pages`);
  if (!results.length) return { mode: "live", gifts: [] };

  // Step 3: pick the best 3
  if (xaiKey) {
    steps.push("Grok is comparing options and choosing the best 3");
    const list = results
      .slice(0, 15)
      .map((r, i) => `[${i}] ${r.title}\n${r.url}\n${(r.content || "").slice(0, 300)}`)
      .join("\n\n");
    const pick = await askGrok(xaiKey, model, [
      { role: "system", content: "You are a thoughtful UK gift-shopping agent. Only use the search results given. Return JSON only." },
      {
        role: "user",
        content: `Shopper request: "${request}"\n\nSearch results:\n${list}\n\nPick the 3 best specific products to buy (prefer real product or shop pages, not listicles, and respect the budget). Return {"gifts":[{"index":number,"name":"short product name","price":"£xx or null if unknown","reason":"one warm sentence on why it fits this person"}]}`,
      },
    ]).catch(() => null);
    const gifts = (pick?.gifts || [])
      .filter((g) => results[g.index])
      .slice(0, 3)
      .map((g) => ({
        name: g.name || results[g.index].title,
        price: g.price && g.price !== "null" ? g.price : null,
        reason: g.reason || "",
        url: results[g.index].url,
      }));
    if (gifts.length) {
      steps.push("Done");
      return { mode: "agent", gifts };
    }
    steps.push("Grok didn't answer cleanly, so using top search results");
  }

  // Fallback: plain search results
  return {
    mode: "search",
    gifts: results.slice(0, 3).map((r) => ({
      name: r.title,
      price: null,
      reason: (r.content || "").slice(0, 160) + "…",
      url: r.url,
    })),
  };
}

async function tavilySearch(key, query) {
  const r = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ api_key: key, query, max_results: 6, search_depth: "basic", country: "united kingdom" }),
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}`);
  const data = await r.json();
  return data.results || [];
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
