// api/generate-faqs.js
// Purpose: Secure proxy that fetches site text, (optionally) Tavily signals, and asks OpenAI to draft grounded FAQs.

export const runtime = 'edge'; // Vercel Edge runtime (fast cold start)

// --- Env vars (set in dashboard later) ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY; // optional
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;       // optional
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// --- CORS & helpers ---
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Vary': 'Origin',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}
function bad(code, msg, status = 400) { return json({ error: msg, code }, status); }
function isPrivateHost(u) {
  try {
    const host = new URL(u).hostname;
    return /(^|\.)localhost$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) && (
      host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.16.') || host === '127.0.0.1'
    );
  } catch { return true; }
}
function normQ(s=''){ return s.toLowerCase().replace(/[^\w\s]/g,'').replace(/\s+/g,' ').trim(); }
async function fetchWithTimeout(url, opts = {}, ms = 25000) {
  const c = new AbortController(); const t = setTimeout(()=>c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); } finally { clearTimeout(t); }
}

export default async function handler(req) {
  // Preflight
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return bad('bad_request', 'Use POST', 405);

  const started = Date.now();
  try {
    // Origin allowlist
    const origin = req.headers.get('origin') || '';
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
      return bad('forbidden_origin', 'Origin not allowed', 403);
    }

    // Parse body
    const body = await req.json().catch(()=> ({}));
    const { url, includeSearch = true, existingQuestions = [] } = body || {};
    if (!url || typeof url !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url) || isPrivateHost(url)) {
      return bad('bad_request', 'Provide a public http(s) URL ≤ 2048 chars', 400);
    }
    if (!OPENAI_API_KEY) return bad('bad_request', 'Server missing OPENAI_API_KEY', 400);

    // --- 1) Get site text (Firecrawl / fallback Jina) ---
    let siteText = '';
    try {
      if (FIRECRAWL_API_KEY) {
        const r = await fetchWithTimeout('https://api.firecrawl.dev/v2/scrape', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, storeInCache: true, timeout: 20000 })
        }, 23000);
        if (r.ok) {
          const data = await r.json();
          siteText = (data?.data?.markdown || data?.data?.html || '') + '';
        }
      }
      if (!siteText) {
        const proxied = 'https://r.jina.ai/http://' + url.replace(/^https?:\/\//,'');
        const r2 = await fetchWithTimeout(proxied, { headers: { 'User-Agent': 'InstantFAQ/1.0' } }, 23000);
        if (r2.ok) siteText = await r2.text();
      }
    } catch { /* continue with empty */ }
    siteText = (siteText || '').replace(/\s+/g, ' ').slice(0, 40000);

    // --- 2) Tavily search (optional) ---
    let searchFindings = [];
    if (includeSearch && TAVILY_API_KEY) {
      const host = new URL(url).hostname.replace(/^www\./,'');
      const qVariants = [`${host} FAQ`, `${host} return policy`, `${host} warranty`, `${host} problems`, `how to ${host}`, `${host} shipping`];
      try {
        const r = await fetchWithTimeout('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: qVariants.join(' | '), search_depth: 'advanced', max_results: 10 })
        }, 23000);
        if (r.ok) {
          const data = await r.json();
          const items = (data?.results || []).map(x => (x?.title || x?.snippet || '')).filter(Boolean);
          const uniq = new Set();
          for (const s of items) {
            const k = normQ(s);
            if (!k || uniq.has(k)) continue;
            uniq.add(k);
            searchFindings.push(s);
            if (searchFindings.length >= 20) break;
          }
        }
      } catch {}
    }

    // --- 3) OpenAI generation ---
    const sys = `You are a precise technical writer. Generate a grounded FAQ...`;
    const user = { site_text_preview: siteText, search_findings: searchFindings, existing_questions: Array.isArray(existingQuestions) ? existingQuestions : [] };

    async function draftFAQs() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(user) }]
          })
        }, 23000);
        if (!r.ok) { if (attempt === 2) return null; await new Promise(res => setTimeout(res, 500*(attempt+1))); continue; }
        const out = await r.json();
        try { return JSON.parse(out?.choices?.[0]?.message?.content || '{}')?.faqs || []; } catch {}
      }
      return null;
    }

    let faqs = await draftFAQs();
    if (!faqs) return bad('llm_failed', 'Failed to generate FAQs', 502);

    // dedupe + sanitize
    const seen = new Set((existingQuestions||[]).map(normQ));
    const clean = [];
    for (const x of faqs) {
      const q = String(x?.q||'').trim(), a = String(x?.a||'').trim();
      if (!q || !a || seen.has(normQ(q))) continue;
      seen.add(normQ(q));
      clean.push({ q, a, confidence: ['high','medium','low'].includes(x?.confidence) ? x.confidence : 'medium', sources: x?.sources?.slice(0,5)||[] });
      if (clean.length >= 12) break;
    }

    console.log(JSON.stringify({ duration_ms: Date.now()-started, provider_used:{firecrawl:!!FIRECRAWL_API_KEY,tavily:!!TAVILY_API_KEY}, retry_count:3-(faqs?1:3) }));
    return json({ faqs: clean }, 200);
  } catch (e) {
    return bad('bad_request', e?.message || 'Unexpected error', 400);
  }
}
