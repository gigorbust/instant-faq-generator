// api/generate-faqs.js
// Grounded FAQ generation with enrichment + internal search queries + security hardening.

function rid(){ return Math.random().toString(36).slice(2)+Date.now().toString(36); }
const startedAt = () => Date.now();
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

function normQ(s=""){ return s.toLowerCase().replace(/[^\w\s]/g,"").replace(/\s+/g," ").trim(); }

// ---------- CORS with allowlist ----------
const ALLOWED = (process.env.ALLOWED_ORIGINS||"").split(",").map(s=>s.trim()).filter(Boolean);
function originAllowed(req){
  if (!ALLOWED.length) return true;
  const o = req.headers.origin || "";
  if (!o) return false;
  try{
    const host = new URL(o).hostname;
    return ALLOWED.some(allowed=>{
      try{ return new URL(allowed).hostname===host; }
      catch{ return allowed.replace(/^https?:\/\//,"")===host; }
    });
  }catch{ return false; }
}
function setCors(req,res){
  const origin = req.headers.origin;
  if (originAllowed(req) && origin) res.setHeader("Access-Control-Allow-Origin", origin);
  else res.setHeader("Access-Control-Allow-Origin", "null"); // strict fallback
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS,GET");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
  res.setHeader("Vary","Origin");
}

// ---------- SSRF guard ----------
function isPrivateHost(host){
  const h = (host||"").toLowerCase();
  if (["localhost","127.0.0.1","0.0.0.0","::1"].includes(h)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)){
    const [a,b] = h.split(".").map(Number);
    if (a===10) return true;
    if (a===172 && b>=16 && b<=31) return true;
    if (a===192 && b===168) return true;
    if (a===127) return true;
  }
  if (h.startsWith("169.254.")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  return false;
}

// ---------- simple best-effort rate limit (per instance) ----------
const RATE = { HOURLY: Number(process.env.RATE_LIMIT_HOURLY||10) };
const bucket = new Map(); // ip -> { reset,count }
function clientIp(req){
  const xf = String(req.headers["x-forwarded-for"]||"");
  return xf.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}
function checkRate(ip){
  const now = Date.now();
  const item = bucket.get(ip) || { reset: now+3600_000, count:0 };
  if (now > item.reset){ item.reset = now+3600_000; item.count = 0; }
  item.count++;
  bucket.set(ip,item);
  return item.count <= RATE.HOURLY;
}

// ---------- timed fetch ----------
async function timedFetch(url, opts={}, ms=25000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), ms);
  try{ return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally{ clearTimeout(t); }
}

// ---------- Firecrawl ----------
async function firecrawlScrape(url){
  if (!process.env.FIRECRAWL_API_KEY) return null;
  try{
    const r = await timedFetch("https://api.firecrawl.dev/v1/scrape",{
      method:"POST",
      headers:{ "Authorization":`Bearer ${process.env.FIRECRAWL_API_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({ url, formats:["markdown","html"], onlyMainContent:true })
    }, 25000);
    if (!r.ok) return null;
    const j = await r.json();
    const txt = (j?.markdown || j?.text || "").replace(/\s+/g," ").slice(0, 70000);
    return txt || null;
  }catch{ return null; }
}

// ---------- Lightweight HTML→text fallback ----------
async function fetchTextSimple(url, timeoutMs=12000){
  const r = await timedFetch(url, { headers:{ "user-agent":"Mozilla/5.0 (FAQGen/1.2)" } }, timeoutMs);
  const html = await r.text();
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/\s+/g," ");
  return text.slice(0, 50000);
}

// ---------- Tavily enrichment ----------
async function tavilyFindings(base, { includeSearch, includeSocial, includeReviews }){
  if (!process.env.TAVILY_API_KEY) return [];
  if (!includeSearch && !includeSocial && !includeReviews) return [];
  const brand = base.replace(/^https?:\/\//,"").replace(/\/.*/,"");
  const queries = [];

  if (includeSearch){
    queries.push(`${brand} faq`, `${brand} pricing`, `${brand} shipping`, `${brand} returns`,
      `${brand} privacy`, `${brand} warranty`, `${brand} troubleshooting`, `${brand} accessibility`,
      `${brand} subscription cancel`, `${brand} reviews`);
  }
  if (includeSocial){
    queries.push(`site:twitter.com ${brand}`, `site:x.com ${brand}`, `site:instagram.com ${brand}`,
      `site:youtube.com ${brand}`, `site:linkedin.com/company ${brand}`);
  }
  if (includeReviews){
    queries.push(`${brand} site:google.com reviews`, `${brand} site:yelp.com`, `${brand} site:facebook.com reviews`, `${brand} press news`);
  }

  const out=[]; const seen=new Set();
  for (const q of queries){
    try{
      const r = await timedFetch("https://api.tavily.com/search",{
        method:"POST",
        headers:{ "Content-Type":"application/json", "X-API-Key":process.env.TAVILY_API_KEY },
        body: JSON.stringify({ query:q, search_depth:"advanced", include_answer:false, max_results:3 })
      }, 12000);
      if (!r.ok) continue;
      const j = await r.json();
      for (const it of (j?.results||[])){
        const key = (it.url||"").split("#")[0];
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ url:it.url, title:it.title, snippet:(it.snippet||"").slice(0,300) });
      }
      await sleep(80);
    }catch{}
  }
  return out.slice(0,28);
}

// ---------- Embeddings (optional semantic dedupe) ----------
async function embedTexts(texts){
  const r = await timedFetch("https://api.openai.com/v1/embeddings",{
    method:"POST",
    headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({ model:"text-embedding-3-small", input:texts })
  }, 20000);
  if (!r.ok) throw new Error("Embeddings failed");
  const j = await r.json();
  return j?.data?.map(d=>d.embedding) || [];
}
function cosSim(a,b){ let dot=0, na=0, nb=0; for(let i=0;i<a.length;i++){ const x=a[i],y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; } return dot/(Math.sqrt(na)*Math.sqrt(nb)+1e-9); }
async function semanticFilter(existingQs, candidates){
  if (!process.env.OPENAI_API_KEY || process.env.ENABLE_EMBED_DEDUPE!=="true") return candidates;
  const ex = existingQs.slice(0,50).map(normQ);
  const cand = candidates.map(x=>x.q);
  if (!ex.length || !cand.length) return candidates;
  const [exEmb, candEmb] = await Promise.all([ embedTexts(ex), embedTexts(cand) ]);
  const THRESH = Number(process.env.EMBED_DUP_THRESHOLD || 0.88);

  const keep = [];
  for (let i=0;i<cand.length;i++){
    const cVec = candEmb[i]; let maxSim = 0;
    for (let j=0;j<ex.length;j++){ const s = cosSim(cVec, exEmb[j]); if (s>maxSim) maxSim = s; if (maxSim>=THRESH) break; }
    if (maxSim < THRESH) keep.push(candidates[i]);
  }

  const final=[], finalEmb=[];
  for (let i=0;i<keep.length;i++){
    const e = candEmb[i]; let dup=false;
    for (let k=0;k<finalEmb.length;k++){ if (cosSim(e, finalEmb[k]) >= THRESH){ dup=true; break; } }
    if (!dup){ final.push(keep[i]); finalEmb.push(e); }
  }
  return final;
}

// ---------- Seeds (no key fallback) ----------
function seedFaqs(url="", existing=[]){
  const host = (()=>{ try{ return new URL(url).hostname.replace(/^www\./,""); }catch{ return "the site"; }})();
  const base = [
    { q:`What is ${host}?`, a:`This is the official website for ${host}. (Needs verification)`, confidence:"low", sources:[url], category:"product" },
    { q:"How do I contact support?", a:"Use the Contact/Support page linked in the site navigation or footer. (Needs verification)", confidence:"low", sources:[url], category:"policies" },
  ];
  const seen = new Set(existing.map(normQ));
  return base.filter(x=>!seen.has(normQ(x.q)));
}

// ---------- Prompt ----------
function buildPrompt({ siteDomain, siteText, searchFindings, analyticsQueries, existingQuestions, targetCount, underWeighted }){
  const system =
`You are a precise technical writer. Generate a grounded FAQ using ONLY the provided site text, public snippets, and internal search queries.
Rules:
- Transform INTERNAL SEARCH QUERIES into clear, helpful FAQs when supported by site text; prefer brand URLs in sources.
- If a query isn't supported by site text, either skip it or answer with "(Needs verification)" and confidence="low".
- Each answer is 1–4 sentences, concrete and helpful.
- Cite at least one source URL per FAQ (prefer brand pages).
- Exclude any question that matches existingQuestions after normalization.
- Aim for category diversity; prioritize: ${Array.isArray(underWeighted)&&underWeighted.length? underWeighted.join(", ") : "none"}.
Return STRICT JSON only:
{ "faqs":[ { "q":"string", "a":"string", "confidence":"high|medium|low",
  "category":"pricing|orders|shipping|returns|product|setup|troubleshooting|policies|accessibility|hours|other",
  "sources":["url"], "alt":["string"] } ],
  "meta": { "coverage": { "pricing":0,"orders":0,"shipping":0,"returns":0,"product":0,"setup":0,"troubleshooting":0,"policies":0,"accessibility":0,"hours":0,"other":0 } } }`;

  const userPayload = {
    siteDomain, targetCount, existingQuestions, underWeighted,
    siteTextPreview: (siteText||"").slice(0, 40000),
    searchFindingsPreview: (searchFindings||[]).slice(0, 20),
    analyticsQueries: (analyticsQueries||[]).slice(0, 50)
  };
  return { system, user: JSON.stringify(userPayload) };
}
function parseJsonish(s){ try{ return JSON.parse(s); }catch{ const i=s.indexOf("{"), j=s.lastIndexOf("}"); if(i!==-1&&j!==-1&&j>i){ try{ return JSON.parse(s.slice(i,j+1)); }catch{} } } return null; }

// ---------- Handler ----------
export default async function handler(req,res){
  setCors(req,res);
  if (req.method==="OPTIONS") return res.status(204).end();

  // Allowlist check
  if (!originAllowed(req)) return res.status(403).json({ error:"Forbidden origin", code:"forbidden_origin" });

  // Rate limit
  const ip = clientIp(req);
  if (!checkRate(ip)) return res.status(429).json({ error:"Rate limit exceeded", code:"rate_limited" });

  if (req.method==="GET"){
    return res.status(200).json({ ok:true, hint:"POST { url, siteSearchQueries?, existingQuestions?, underWeighted? }" });
  }
  if (req.method!=="POST"){
    return res.status(405).json({ error:"Use POST" });
  }

  const t0 = startedAt();

  // Parse body robustly
  let body = req.body;
  if (typeof body === "string") { try{ body = JSON.parse(body); }catch{ body = {}; } }
  if (!body || typeof body !== "object") body = {};

  try{
    let { url, includeSearch=true, includeSocial, includeReviews, siteSearchQueries, existingQuestions=[], underWeighted=[] } = body;

    // Validate URL + SSRF guard
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error:"Missing or invalid `url`", code:"bad_request" });
    let siteDomain = "";
    try{
      const u = new URL(url);
      siteDomain = u.hostname.replace(/^www\./,"");
      if (isPrivateHost(u.hostname)) return res.status(403).json({ error:"Blocked host", code:"ssrf_blocked" });
    }catch{ return res.status(400).json({ error:"Invalid URL", code:"bad_request" }); }

    // Link social/reviews to search toggle by default (we keep search always-on conceptually)
    if (typeof includeSocial === 'undefined') includeSocial = !!includeSearch;
    if (typeof includeReviews === 'undefined') includeReviews = !!includeSearch;

    // Normalize internal search analytics (manual paste for now)
    const analyticsQueries = Array.isArray(siteSearchQueries)
      ? siteSearchQueries.map(s=>String(s).trim()).filter(Boolean).slice(0,50)
      : [];

    // 1) Crawl → fallback single page
    let siteText = null;
    try{ siteText = await firecrawlScrape(url); }catch{}
    if (!siteText){
      try{ siteText = await fetchTextSimple(url, 12000); }catch{}
    }

    // 2) Enrichment (always on if keys present)
    let searchFindings = [];
    try{ searchFindings = await tavilyFindings(url, { includeSearch:true, includeSocial, includeReviews }); }catch{}

    // 3) No OpenAI key → deterministic seeds so UI still works
    if (!process.env.OPENAI_API_KEY){
      const faqs = seedFaqs(url, existingQuestions);
      return res.status(200).json({ faqs, tookMs: Date.now()-t0 });
    }

    // 4) LLM call
    const initial = (existingQuestions||[]).length===0;
    const targetCount = initial ? 10 : 7;
    const { system, user } = buildPrompt({
      siteDomain, siteText, searchFindings, analyticsQueries, existingQuestions, targetCount, underWeighted
    });

    let retries = 0, jsonOut = null;
    while (retries < 3 && !jsonOut){
      const ai = await timedFetch("https://api.openai.com/v1/chat/completions",{
        method:"POST",
        headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
        body: JSON.stringify({
          model:"gpt-4o-mini",
          temperature:0.2,
          response_format:{ type:"json_object" },
          messages:[ {role:"system", content:system}, {role:"user", content:user} ]
        })
      }, 25000);

      if (!ai.ok){
        const txt = await ai.text().catch(()=> "");
        const lower = txt.toLowerCase();
        if (lower.includes("insufficient_quota")) return res.status(429).json({ error:"OpenAI quota exceeded.", code:"llm_failed" });
        if (lower.includes("invalid api key"))    return res.status(401).json({ error:"Invalid OpenAI API key.", code:"llm_failed" });
        return res.status(502).json({ error:`OpenAI error ${ai.status}`, code:"llm_failed" });
      }
      const data = await ai.json();
      jsonOut = parseJsonish(data?.choices?.[0]?.message?.content || "");
      if (!jsonOut) retries++;
    }
    if (!jsonOut) return res.status(502).json({ error:"Invalid JSON from model", code:"llm_failed" });

    // 5) Sanitize + string-dedupe vs existing
    let faqs = Array.isArray(jsonOut.faqs) ? jsonOut.faqs : [];
    const seen = new Set((existingQuestions||[]).map(normQ));
    faqs = faqs
      .filter(x => x && x.q && x.a)
      .filter(x => !seen.has(normQ(String(x.q))))
      .map(x => ({
        q: String(x.q).trim(),
        a: String(x.a).trim(),
        confidence: /^(high|medium|low)$/i.test(x.confidence||"") ? x.confidence.toLowerCase() : "medium",
        category: /^(pricing|orders|shipping|returns|product|setup|troubleshooting|policies|accessibility|hours|other)$/i.test(x.category||"") ? x.category.toLowerCase() : "other",
        sources: Array.isArray(x.sources)&&x.sources.length ? x.sources.slice(0,4) : (siteDomain ? [`https://${siteDomain}`] : []),
      }));

    // 6) Optional semantic dedupe
    if (faqs.length && process.env.ENABLE_EMBED_DEDUPE==="true"){
      faqs = await semanticFilter(existingQuestions, faqs);
    }

    if (!faqs.length){
      const seeds = seedFaqs(url, existingQuestions);
      return res.status(200).json({ faqs: seeds, tookMs: Date.now()-t0 });
    }

    console.log(JSON.stringify({
      lvl:"info", duration_ms: Date.now()-t0, provider_used:"openai",
      retry_count: retries, count: faqs.length
    }));

    return res.status(200).json({ faqs, tookMs: Date.now()-t0 });
  }catch(e){
    console.error(JSON.stringify({ lvl:"error", err: e?.message||String(e) }));
    const msg = e?.name==="AbortError" ? "Timed out" : (e?.message || "Server error");
    return res.status(500).json({ error: msg, code:"timeout" });
  }
}
