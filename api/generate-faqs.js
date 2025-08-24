Developer: Role and Objective
- Design and deliver a complete codebase and documentation for **Instant FAQ Generator**, a minimalist single-page application (SPA) with a stateless, serverless backend for paid microsaaS use. The app generates FAQ snippets from public web content, providing seamless editing and export for users, with no authentication or persistent storage.

Instructions
- Begin each major development phase with a concise conceptual checklist (3-7 bullets) outlining planned steps before implementation.
- For every phase, directly provide the final outputs and include succinct validation notes verifying core requirements.
- When using external APIs or tools, always preface code with a one-line comment stating the purpose and listing minimal validated input data.
- Apply strict input/output schemas (`response_format: json_object`) for all OpenAI and API interactions. Enforce schema validation with up to 2 retries using exponential backoff if violations occur.

Product Overview
- Accepts input: Public website URL.
- Backend processes: Crawl using **Firecrawl** (max 15 pages, maxDepth 2, same domain, robots.txt/canonical respected, excess boilerplate removed). If unsuccessful, use `https://r.jina.ai/http://...` as fallback.
- Optionally utilize **Tavily** for supplementary search signal queries (if enabled), using multiple phrasings to broaden FAQ generation. If Tavily is unavailable, continue without error.
- Quality assurance: Deduplicate and normalize inputs and generated questions. Limit preview size to ~40k characters.
- Synthesis: Use **OpenAI GPT-4o-mini** to generate concise, source-grounded Q&A pairs in strict JSON format.
- Frontend: Provide intuitive editing (inline, undo, delete, reorder) with a "load more" feature to fetch 5–10 additional unique FAQs, deduped against `existingQuestions`.
- Export: Offer (1) self-contained HTML snippet (all assets/loaders inline, accessible/ARIA-ready accordion), prefix all classes with `.faqgen-`, wrap in `<div id="faqgen-root">`, and include a toggle for Sources (default off); and (2) JSON-LD FAQPage (reflecting selected content).

Hard Constraints
- No user authentication, persistent storage, or database.
- API keys and secrets must remain server-side; the front-end must never expose them.
- Provide a single stateless serverless endpoint only.
- Solution must be deployable via Vercel, Netlify, or Cloudflare Workers dashboards (not CLI tools).

Security & Abuse Controls
- Allowlist requests via an `ALLOWED_ORIGINS` environment variable; otherwise, reply with HTTP `403` and standardized JSON error.
- Enforce per-IP rate limits (e.g., 10/hour or 50/day); reply with HTTP `429` if exceeded.
- Rigorously validate inputs: accept only absolute http(s) URLs (≤2048 chars), reject private IPs.
- Set strict timeouts for external calls (≤25s each) and total request duration (≤45s).
- Log only the following non-PII operational metadata: `{duration_ms, provider_used, retry_count}`; never log secrets or user content.

API & Prompting
- Endpoint: **POST** `/api/generate-faqs`
  - Request JSON:
    ```json
    { "url": "https://example.com", "includeSearch": true, "existingQuestions": ["What is your return policy?"] }
    ```
  - Success JSON:
    ```json
    {
      "faqs": [
        { "q": "string", "a": "string", "confidence": "high|medium|low", "sources": ["https://..."] }
      ]
    }
    ```
  - Error JSON:
    ```json
    { "error": "string", "code": "bad_request|crawl_failed|search_unavailable|llm_failed|rate_limited|forbidden_origin" }
    ```
- Document and illustrate error handling with clear examples that reflect all standardized error codes.
- Set `Access-Control-Allow-Origin: *` and `Vary: Origin` headers on all responses.

Prompting OpenAI
- Always use `model = "gpt-4o-mini"`, `temperature = 0.2`, and `response_format = { "type": "json_object" }`.
- System message: Guide completions to generate specific, source-linked, grounded FAQs (with explicit notes and confidence levels as needed).
- User message includes: `{ "site_text_preview": "...", "search_findings": [...], "existing_questions": [...] }`.
- On invalid schema, automatically retry up to 2 times with incremental correction hints.
- Enforce these patterns in all relevant API code.

Data & Quality Rules
- Normalize and deduplicate all data and questions (collapse whitespace, remove duplicates).
- Ensure every FAQ response cites at least one source URL, or is labeled "(Needs verification)" with `confidence = "low"`.
- Remove duplicate questions using canonical normalization.
- Prioritize coverage diversity: ensure the first 10 questions span common domains (pricing, shipping, returns, features, setup, integrations, privacy, support, etc.).
- First run should generate 8–12 FAQs in ≤20s; "load more" returns 5–10 new, deduped FAQs per request.

Frontend (Static)
- Deliver as a single `index.html` file (plus optional `app.js`).
- UI must use a modern minimalist dark mode, accessible one-open accordion, and smooth animations.
- Enable editing (inline, undo, reorder) and provide a clear "load more/expand" feature to fetch new FAQs.
- Export: Easy copy actions for both HTML and JSON-LD snippets, both accurately mirroring displayed content.
- Exported HTML snippet must prefix all classes with `.faqgen-`, be wrapped in `<div id="faqgen-root">`, and include a toggle for Sources (default off).
- Application must remain resilient and functional even if the backend is unavailable.

Backend (Serverless, Stateless)
- Clearly document required environment variables.
- Request logic proceeds stepwise: validate/authorize → crawl → (optional search) → synthesize → dedupe/merge → respond. After each major step, validate outcome in 1-2 lines and decide to proceed or self-correct if validation fails.
- Set CORS headers (`Access-Control-Allow-Origin: *`, `Vary: Origin`) explicitly on all responses and enforce statelessness throughout.
- Set strict timeouts of ≤25s per upstream call and ≤45s total per request.
- If Firecrawl fails, automatically use `r.jina.ai` as a fallback.
- Continue without error if Tavily is unavailable.
- Log only `{duration_ms, provider_used, retry_count}` as operational metadata.
- Organize all documentation and code sequentially, under titled Markdown headers as detailed below.

Acceptance & Validation
- All logical flows and acceptance tests must operate as specified.
- Frontend editing/export, backend API routing, and error handling must align precisely with requirements.

Output Format
- Deliver a single Markdown README with the following clearly-labeled, strictly ordered sections:
  1. # Overview
  2. # Frontend
     - Static UI code, explanations, validation notes
  3. # Backend
     - Full serverless function code, deployment notes, sample errors, validation
  4. # API Interface
     - Docs, schemas, error samples, validation
  5. # Export Formats
     - Real example HTML snippet (```html fenced) and JSON-LD FAQPage (```json fenced), both containing matching (non-placeholder) sample FAQ content, correctly ordered.
     - Include validation notes on structure, a11y, and Rich Results conformance.
- In all code, use inline comments for external API/third-party interaction and for all schema/response validation logic.
- Strictly adhere to the specified README structure and section ordering.

Policy
- Attempt a first pass on all steps autonomously unless missing critical information; ask for clarification if any essential success criteria or requirements cannot be met based on provided details.
