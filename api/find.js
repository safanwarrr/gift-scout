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
      tavilySearch(tavilyKey, q, i === 0 ? `Suggest exactly 3 specific, real, named gift products (brand + model) available to buy in the UK for: ${request}. Stay within budget. Answer with exactly 3 lines in this format and nothing else: Product name | approx price in £ | one warm sentence on why it suits them` : null).catch(() => ({ results: [] }))
    )
  );
  let advice = searches[0].answer || null;
  let ideas = parseIdeas(advice);
  if (ideas.length < 2) ideas = parseProse(advice);
  const seen = new Set();
  const results = searches
    .flatMap((s) => s.results || [])
    .filter((r) => r.url && !SOCIAL.test(hostOf(r.url)) && !seen.has(r.url) && seen.add(r.url));
  steps.push(`Read ${results.length} pages from across the web`);
  if (!results.length) return { mode: "live", advice, gifts: [] };

  // Step 3a: the AI named specific products, so find a real shop page for each
  if (!xaiKey && ideas.length >= 2) {
    steps.push(`AI shortlisted: ${ideas.map((i) => i.name).join(", ")}`);
    steps.push("Finding a UK shop selling each one");
    const found = await Promise.all(
      ideas.map((idea) =>
        tavilySearch(tavilyKey, `${idea.name} buy UK`, null, "basic")
          .then((s) => (s.results || []).filter((r) => r.url && !SOCIAL.test(hostOf(r.url))))
          .catch(() => [])
      )
    );
    const used = new Set();
    const blocked = new Set();
    found.flat().forEach((r) => { const t = checkShop(r.url); if (t.level === "copycat") blocked.add(hostOf(r.url)); });
    const gifts = ideas.map((idea, i) => {
      const best = rankResults(found[i].filter((r) => !used.has(r.url)), budget, true)[0];
      if (best) used.add(best.url);
      const url = best?.url || `https://www.google.co.uk/search?tbm=shop&q=${encodeURIComponent(idea.name)}`;
      return {
        name: idea.name,
        price: idea.price || best?.price || null,
        reason: idea.reason,
        url,
        trust: best ? best.trust : { level: "search", label: "No safe shop found · compare prices" },
      };
    });
    steps.push(safetyStep(gifts, blocked));
    steps.push("Done");
    return { mode: "tavily-agent", advice: null, gifts };
  }

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
      trust: checkShop(results[g.index].url),
    })).filter((g) => g.trust.level !== "copycat");
    if (gifts.length) { steps.push("Done"); return { mode: "agent", advice, gifts }; }
  }

  steps.push("Scored every page: real shops over blog lists, within budget, different stores");
  const blocked = new Set(results.filter((r) => checkShop(r.url).level === "copycat").map((r) => hostOf(r.url)));
  const gifts = rankResults(results, budget).slice(0, 3);
  steps.push(safetyStep(gifts, blocked));
  steps.push("Done");
  return { mode: "tavily", advice, gifts };
}

// ---------- Shop safety check ----------
// Well-known UK retailers and marketplaces (subdomains count too, e.g. store.lego.com).
const TRUSTED = {
  "amazon.co.uk": "Amazon", "argos.co.uk": "Argos", "johnlewis.com": "John Lewis", "etsy.com": "Etsy",
  "ebay.co.uk": "eBay", "notonthehighstreet.com": "Not On The High Street", "boots.com": "Boots",
  "superdrug.com": "Superdrug", "lookfantastic.com": "LookFantastic", "cultbeauty.co.uk": "Cult Beauty",
  "spacenk.com": "Space NK", "sephora.co.uk": "Sephora", "beautybay.com": "Beauty Bay", "lush.com": "Lush",
  "thebodyshop.com": "The Body Shop", "charlottetilbury.com": "Charlotte Tilbury", "theordinary.com": "The Ordinary",
  "selfridges.com": "Selfridges", "harrods.com": "Harrods", "libertylondon.com": "Liberty",
  "fortnumandmason.com": "Fortnum & Mason", "harveynichols.com": "Harvey Nichols",
  "marksandspencer.com": "M&S", "next.co.uk": "Next", "very.co.uk": "Very", "currys.co.uk": "Currys",
  "ao.com": "AO", "waterstones.com": "Waterstones", "whsmith.co.uk": "WHSmith", "blackwells.co.uk": "Blackwell's",
  "foyles.co.uk": "Foyles", "uk.bookshop.org": "Bookshop.org", "theworks.co.uk": "The Works",
  "hobbycraft.co.uk": "Hobbycraft", "smythstoys.com": "Smyths", "hamleys.com": "Hamleys",
  "thetoyshop.com": "The Entertainer", "lego.com": "LEGO", "decathlon.co.uk": "Decathlon",
  "lakeland.co.uk": "Lakeland", "souschef.co.uk": "Sous Chef", "firebox.com": "Firebox",
  "menkind.co.uk": "Menkind", "prezzybox.com": "Prezzybox", "iwantoneofthose.com": "IWOOT",
  "zavvi.com": "Zavvi", "hmv.com": "HMV", "game.co.uk": "GAME", "tesco.com": "Tesco",
  "sainsburys.co.uk": "Sainsbury's", "waitrose.com": "Waitrose", "ocado.com": "Ocado",
  "sportsdirect.com": "Sports Direct", "jdsports.co.uk": "JD Sports", "wiggle.com": "Wiggle",
  "halfords.com": "Halfords", "cotswoldoutdoor.com": "Cotswold Outdoor", "gooutdoors.co.uk": "GO Outdoors",
  "anglingdirect.co.uk": "Angling Direct", "asos.com": "ASOS", "hm.com": "H&M", "uniqlo.com": "Uniqlo",
  "zara.com": "Zara", "ikea.com": "IKEA", "dunelm.com": "Dunelm", "habitat.co.uk": "Habitat",
  "apple.com": "Apple", "screwfix.com": "Screwfix", "yumbles.com": "Yumbles",
  "pastaevangelists.com": "Pasta Evangelists", "carluccios.com": "Carluccio's", "oliveoilavlaki.com": "Avlaki",
  "hotelchocolat.com": "Hotel Chocolat", "thortful.com": "thortful", "moonpig.com": "Moonpig",
  "funkypigeon.com": "Funky Pigeon", "virginexperiencedays.co.uk": "Virgin Experience Days",
  "buyagift.co.uk": "Buyagift", "redletterdays.co.uk": "Red Letter Days",
};
const RISKY_TLD = /\.(shop|top|xyz|online|click|buzz|live|store|site|vip|cyou|icu|sbs)$/i;
const brandOf = (host) =>
  host.replace(/^(www|shop|store|uk)\./, "")
    .replace(/\.(co\.uk|org\.uk|com|net|org|uk|shop|store|online|top|xyz|site|live|click|co)$/i, "")
    .replace(/[-_.]?(uk|gb|official|online|shop|store|outlet|sale|deals|direct)$/i, "")
    .replace(/^(the|shop|buy|official)[-_]?/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
const TRUSTED_BRANDS = Object.fromEntries(Object.keys(TRUSTED).map((d) => [brandOf(d), d]));

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export function checkShop(url) {
  const host = hostOf(url);
  if (!host) return { level: "unverified", label: "Unknown shop" };
  const trusted = Object.keys(TRUSTED).find((d) => host === d || host.endsWith("." + d));
  if (trusted) return { level: "trusted", label: `Trusted UK retailer · ${TRUSTED[trusted]}` };
  const brand = brandOf(host);
  let real = brand.length >= 4 ? TRUSTED_BRANDS[brand] : null;
  if (!real && brand.length >= 6) real = Object.entries(TRUSTED_BRANDS).find(([b]) => b.length >= 6 && editDistance(b, brand) === 1)?.[1];
  if (real) return { level: "copycat", label: `Possible copycat of ${real}`, realDomain: real };
  if (RISKY_TLD.test(host)) return { level: "unverified", label: "Unverified shop · unusual web address" };
  return { level: "unverified", label: "Independent shop · not verified" };
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

function rankResults(results, budget, anyHost = false) {
  const scored = results.filter((r) => checkShop(r.url).level !== "copycat").map((r) => {
    const host = hostOf(r.url);
    const text = `${r.title} ${r.content || ""}`;
    const price = findPrice(text);
    let score = r.score || 0;
    if (SHOPS.test(host)) score += 1;
    if (checkShop(r.url).level === "trusted") score += 2;
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
      if (out.includes(s) || (pass && !anyHost && hosts.has(s.host))) continue;
      out.push(s); hosts.add(s.host);
    }
  }
  return out.map(({ r, price }) => ({
    name: cleanTitle(r.title),
    price: price != null ? `£${price}` : null,
    reason: firstSentence(r.content),
    url: r.url,
    trust: checkShop(r.url),
  }));
}

function safetyStep(gifts, blocked) {
  const ok = gifts.filter((g) => g.trust?.level === "trusted").length;
  let msg = `Safety check: ${ok} of ${gifts.length} links go to trusted UK retailers`;
  if (blocked.size) msg += `, blocked ${blocked.size} copycat site${blocked.size > 1 ? "s" : ""} (${[...blocked].join(", ")})`;
  return msg;
}

function parseIdeas(answer) {
  if (!answer) return [];
  answer = String(answer).replace(/[│｜¦┃]/g, "|");
  let lines = answer.split(/\n+/);
  if (lines.filter((l) => l.split("|").length >= 3).length < 2) {
    // All on one line: "A | £1 | why. B | £2 | why. C | £3 | why."
    const parts = String(answer).split("|").map((x) => x.trim());
    lines = [];
    let name = parts[0];
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const price = parts[i];
      let reason = parts[i + 1], next = "";
      if (i + 2 < parts.length) {
        const m = reason.match(/^(.*?[.!?;])\s+([^.!?;]+)$/) || reason.match(/^(.*[.!?;])\s+(.+)$/);
        if (m) { reason = m[1]; next = m[2]; }
      }
      lines.push(`${name} | ${price} | ${reason}`);
      name = next;
    }
  }
  return lines
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/\*\*/g, "").trim())
    .filter((line) => line.split("|").length >= 3)
    .slice(0, 3)
    .map((line) => {
      const [name, price, ...rest] = line.split("|").map((x) => x.trim());
      const p = String(price).match(/\d+(?:\.\d{1,2})?/);
      return { name: tidyName(name), price: p ? `£${p[0]}` : null, reason: rest.join(" ").trim().replace(/;$/, ".") };
    })
    .filter((i) => i.name && i.reason);
}

// Backup: read a normal paragraph like
// "a premium olive oil (about £15) for drizzling...; a balsamic (roughly £20) that adds..."
function parseProse(answer) {
  if (!answer) return [];
  const segments = String(answer).split(/;\s*|\n+|(?<=[.!?])\s+(?=[A-Z0-9])/);
  const out = [];
  for (const seg of segments) {
    const m = seg.match(/^(.*?)\s*[(\[]?\s*(?:about|around|roughly|approx\.?|approximately|~|≈|at|for)?\s*£\s?(\d+(?:\.\d{1,2})?)(?:\s*(?:-|–|to)\s*£?\s?\d+(?:\.\d{1,2})?)?\s*(?:each)?\s*[)\]]?\s*[-–—,:]?\s*(.*)$/i);
    if (!m) continue;
    let name = m[1]
      .replace(/^\s*(?:\d+[.)]\s*)?(?:(?:and|or|also|consider|try|perhaps|maybe|finally|plus|get)\s+)*(?:(?:a|an|the|some)\s+)?/i, "")
      .split(/\s[–—-]\s|:\s/)[0]
      .replace(/[\s,(–—-]+$/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (name.length < 4) continue;
    name = name[0].toUpperCase() + name.slice(1);
    let reason = m[3]
      .replace(/^\s*[-–—,:)]*\s*/, "")
      .replace(/^(?:which|that)\s+/i, "")
      .replace(/^(?:is|are)\s+/i, "")
      .replace(/[;.,\s]+$/, "")
      .trim();
    reason = reason ? reason[0].toUpperCase() + reason.slice(1) + "." : "A thoughtful pick for them.";
    out.push({ name: tidyName(name), price: `£${m[2]}`, reason });
    if (out.length === 3) break;
  }
  return out;
}

function tidyName(n) {
  let s = String(n).replace(/\s+/g, " ").trim();
  if ((s.match(/\(/g) || []).length > (s.match(/\)/g) || []).length) s = s.replace(/\s*\([^)]*$/, "");
  return s.slice(0, 70);
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }
function cleanTitle(t) { return String(t || "Gift").split(/ [|–-] (?=[^|–-]*$)/)[0].slice(0, 90); }
function firstSentence(t) {
  const s = String(t || "").replace(/[#*_`>|]+/g, " ").replace(/\s+/g, " ").trim();
  const m = s.match(/^.{20,180}?[.!?](\s|$)/);
  return m ? m[0].trim() : s.slice(0, 160) + (s.length > 160 ? "…" : "");
}

async function tavilySearch(key, query, answerQuestion, depth = "advanced") {
  const r = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query: answerQuestion || query,
      max_results: 8,
      search_depth: depth,
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
