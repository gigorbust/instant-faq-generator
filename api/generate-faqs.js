// api/generate-faqs.js
// Node.js Serverless Function for Vercel (NOT Edge). Uses res.status().json().

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function setCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

function seedFaqs(existing = [], url = '') {
  const seen = new Set((existing || []).map(s => s.trim().toLowerCase()));
  const add = (q, a) => (seen.has(q.trim().toLowerCase()) ? null : { q, a });
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'the site'; } })();
  return [
    add(`What is ${host}?`, `It's the website at ${host}.`),
    add('How do I contact support?', 'Look for a “Contact” or “Support” page on the site.'),
    add('Do you have pricing information?', 'See the Pricing page for details.'),
    add('Where can I learn more?', `Browse the navigation on ${host} for docs, blog, or an About page.`)
  ].filter(Boolean);
}

async function fetchText(url, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; FAQGen/1.0)' },
    });
    const html = await r.text();
    return html.replace(/\s+/g, ' ').slice(0, 20000); // light normalize + cap
  } finally {
    clearTimeout(t);
  }
}

function parseJsonish(s) {
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf('{'); const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch {}
  }
  return null;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    // Quick sanity check path: browsing /api/generate-faqs should return fast.
    return res.status(200).json({ ok: true, hint: 'POST { url, includeSearch?, existingQuestions? }' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  try {
    const started = Date.now();
    const { url, includeSearch = true, existingQuestions = [] } = req.body || {};

    if (!url) return res.status(400).json({ error: 'Missing `url`.' });

    // Fetch page text (quick) so we have something to work with
    let pageText = '';
    try { pageText = await fetchText(url); } catch (e) { /* ignore fetch failures; model can still try */ }

    // If there is no OPENAI_API_KEY, respond with seed FAQs so UI still works
    if (!process.env.OPENAI_API_KEY) {
      return res.status(200).json({ faqs: seedFaqs(existingQuestions, url), tookMs: Date.now() - started });
    }

    // Ask OpenAI to draft FAQs
    const prompt = [
      `You are an assistant that writes concise, helpful website FAQs.`,
      `Return STRICT JSON ONLY with shape: {"faqs":[{"q":"...","a":"..."}]}. No prose, no markdown.`,
      `Avoid duplicates. Respect existing questions: ${JSON.stringify(existingQuestions).slice(0, 2000)}`,
      `Website URL: ${url}`,
      `Page text (may be partial): ${pageText.slice(0, 10000)}`
    ].join('\n\n');

    const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!aiResp.ok) {
      const errTxt = await aiResp.text().catch(() => '');
      return res.status(502).json({ error: `OpenAI error ${aiResp.status}`, details: errTxt.slice(0, 400) });
    }

    const data = await aiResp.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = parseJsonish(content) || {};
    let faqs = Array.isArray(parsed.faqs) ? parsed.faqs : [];

    // Fallback if model didn’t give JSON
    if (!faqs.length) faqs = seedFaqs(existingQuestions, url);

    // Deduplicate against existing
    const seen = new Set((existingQuestions || []).map(s => (s || '').trim().toLowerCase()));
    faqs = faqs.filter(x => x?.q && !seen.has(String(x.q).trim().toLowerCase()));

    return res.status(200).json({ faqs, tookMs: Date.now() - started });
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'Timed out' : (e?.message || 'Server error');
    return res.status(500).json({ error: msg });
  }
}
