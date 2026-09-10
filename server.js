/**
 * RAB — Rigor Above Belief
 * Express backend for Render.
 *
 * Holds every secret. The browser never sees an API key or a database
 * credential: it only ever calls same-origin /api/* routes on this server.
 *
 *   GET    /api/models          which models this deployment can actually run
 *   POST   /api/sample          model proxy (Anthropic + OpenAI), streaming or JSON
 *   POST   /api/check           provider-specific claim cross-check
 *   GET    /api/audits          the archive, newest first
 *   POST   /api/audits          save one audit (audit + claims + scores, relational)
 *   DELETE /api/audits/:id      remove one
 *   GET    /api/reports         aggregates for the in-app dashboard
 *   GET    /healthz             liveness, and a cheap way to keep Render warm
 */

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.set({
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'",
  });
  if (req.path.startsWith("/api/")) res.set("cache-control", "no-store");
  next();
});

const ACCESS_USER = process.env.RAB_USERNAME;
const ACCESS_PASSWORD = process.env.RAB_PASSWORD;
const accessProtected = () => !!(ACCESS_USER && ACCESS_PASSWORD);
function safeEqual(actual, expected) {
  const a = Buffer.from(String(actual));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
app.use((req, res, next) => {
  if (!accessProtected() || req.path === "/healthz") return next();
  const header = req.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  let user = "", password = "";
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator >= 0) {
      user = decoded.slice(0, separator);
      password = decoded.slice(separator + 1);
    }
  }
  if (safeEqual(user, ACCESS_USER) && safeEqual(password, ACCESS_PASSWORD)) return next();
  res.set("www-authenticate", 'Basic realm="RAB Workbench", charset="UTF-8"');
  return res.status(401).send("RAB Workbench sign-in required.");
});
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

/* This in-process limiter protects a single Render instance from accidental
   request loops and casual API-credit abuse. Use a shared Redis-backed limiter
   if the service is ever scaled horizontally. */
const rateBuckets = new Map();
function rateLimit({ windowMs, max, key = "general" }) {
  return (req, res, next) => {
    const now = Date.now();
    const id = `${key}:${req.ip}`;
    const current = rateBuckets.get(id);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;
    bucket.count += 1;
    rateBuckets.set(id, bucket);
    res.set("x-ratelimit-limit", String(max));
    res.set("x-ratelimit-remaining", String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      res.set("retry-after", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: { code: "rate_limited", message: "Too many requests. Please wait a moment and try again." } });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [id, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(id);
}, 5 * 60 * 1000).unref();

/* ------------------------------------------------------------------ models */
/* The allowlist. The browser can only ask for something on this list, so a
   crafted request cannot make this server call an arbitrary model.
   Verified against the vendor model pages 2026-09-02 — IDs do get retired. */
const MODEL_CATALOG = [
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", provider: "anthropic", apiId: process.env.ANTHROPIC_MODEL_FABLE || "claude-fable-5-1", note: "Demanding reasoning, long-horizon work" },
  { id: "claude-opus-5",    label: "Claude Opus 5",    provider: "anthropic", apiId: process.env.ANTHROPIC_MODEL_COMPLEX || "claude-opus-5", note: "Complex agentic and enterprise work" },
  { id: "claude-sonnet-5",  label: "Claude Sonnet 5",  provider: "anthropic", apiId: process.env.ANTHROPIC_MODEL_DEFAULT || "claude-sonnet-5", note: "Speed and intelligence balanced" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic", apiId: process.env.ANTHROPIC_MODEL_QUICK || "claude-haiku-4-5", note: "Fastest, near-frontier" },
  { id: "gpt-6-astra",      label: "GPT-6 Astra",      provider: "openai",    apiId: process.env.OPENAI_MODEL_COMPLEX || "gpt-6-astra", note: "Flagship, complex professional work" },
  { id: "gpt-5.6-terra",    label: "GPT-5.6 Terra",    provider: "openai",    apiId: process.env.OPENAI_MODEL_DEFAULT || "gpt-5.6-terra", note: "Balances intelligence and cost" },
  { id: "gpt-5.6-luna",     label: "GPT-5.6 Luna",     provider: "openai",    apiId: process.env.OPENAI_MODEL_QUICK || "gpt-5.6-luna", note: "Cost-sensitive workloads" },
];
const TIER_CANDIDATES = {
  /* Core workbench tasks use the already-tested OpenAI connection first.
     Provider-specific claim checks still call Claude and Gemini directly. */
  quick: ["gpt-5.6-luna", "claude-haiku-4-5"],
  default: ["gpt-5.6-terra", "claude-sonnet-5"],
  complex: ["gpt-6-astra", "claude-opus-5"],
};

const PROVIDER_KEY_NAMES = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};
const hasKey = (p) => !!(PROVIDER_KEY_NAMES[p] && process.env[PROVIDER_KEY_NAMES[p]]);
const byId = (id) => MODEL_CATALOG.find((m) => m.id === id) || null;
function resolveModel(requested) {
  const want = typeof requested === "string" && requested ? requested : "default";
  if (Object.prototype.hasOwnProperty.call(TIER_CANDIDATES, want)) {
    const override = byId(process.env[`MODEL_${want.toUpperCase()}`]);
    if (override && hasKey(override.provider)) return override;
    const candidates = TIER_CANDIDATES[want].map(byId).filter(Boolean);
    return candidates.find((model) => hasKey(model.provider)) || candidates[0] || null;
  }
  return byId(want);
}

/* ------------------------------------------------------------------ supabase */
const SUPA_URL = process.env.SUPABASE_URL;
/* Supabase is retiring the legacy `service_role` JWT in favour of `sb_secret_...`
   keys (both work through 2026). Accept either name so an older deployment keeps
   running, and prefer the new one. */
const SUPA_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
const supa = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } }) : null;
const archiveOn = () => !!supa;

const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });

/* -------------------------------------------------------------- GET /models */
app.get("/api/models", (req, res) => {
  res.json({
    models: MODEL_CATALOG.map((m) => ({ id: m.id, label: m.label, provider: m.provider, note: m.note, available: hasKey(m.provider) })),
    providers: { anthropic: hasKey("anthropic"), openai: hasKey("openai"), gemini: hasKey("gemini") },
    archive: archiveOn(),
    reports: archiveOn(),
  });
});

/* ------------------------------------------------------------- POST /sample */
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_TOKENS = 4096;

function toMessages(input) {
  if (typeof input === "string") return input.trim() ? [{ role: "user", content: input }] : null;
  if (!Array.isArray(input) || !input.length) return null;
  for (const m of input) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
    if (typeof m.content !== "string" || !m.content) return null;
  }
  if (input[0].role !== "user" || input[input.length - 1].role !== "user") return null;
  return input;
}

app.post("/api/sample", rateLimit({ windowMs: 60_000, max: 20, key: "models" }), async (req, res) => {
  const messages = toMessages(req.body && req.body.input);
  if (!messages) return fail(res, 400, "invalid_request", "input must be a non-empty string, or turns starting and ending with a user turn.");

  const bytes = Buffer.byteLength(messages.map((m) => m.content).join(""), "utf8");
  if (bytes > MAX_INPUT_BYTES) return fail(res, 400, "prompt_too_large", `Input is ${Math.round(bytes / 1024)} KB; the limit is 64 KB. Send an excerpt.`);

  const picked = resolveModel(req.body.model);
  if (!picked) return fail(res, 400, "invalid_request", `Unknown model. Available: ${MODEL_CATALOG.map((m) => m.id).join(", ")}`);

  const key = picked.provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) {
    const varName = picked.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    return fail(res, 503, "not_configured", `No API key is set for ${picked.provider}. Add ${varName} to this service's environment variables.`);
  }

  const temperature = Math.max(0, Math.min(1, Number(req.body.temperature ?? 0) || 0));
  const wantStream = req.body.stream === true;

  let upstream;
  try {
    upstream = picked.provider === "anthropic"
      ? await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: picked.apiId, max_tokens: MAX_OUTPUT_TOKENS, messages, stream: wantStream, temperature }),
        })
      : await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: picked.apiId, messages, stream: wantStream, temperature, max_completion_tokens: MAX_OUTPUT_TOKENS }),
        });
  } catch (e) {
    return fail(res, 502, "upstream_error", `Could not reach ${picked.provider}: ${e.message}`);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    let msg = "";
    try { msg = JSON.parse(detail)?.error?.message || ""; } catch { msg = String(detail).slice(0, 300); }
    const code = upstream.status === 401 || upstream.status === 403 ? "auth_failed"
      : upstream.status === 429 ? "rate_limited"
      : upstream.status >= 500 ? "upstream_error" : "upstream_rejected";
    return fail(res, upstream.status === 429 ? 429 : 502, code, msg || `${picked.provider} returned ${upstream.status}.`);
  }

  if (!wantStream) {
    const data = await upstream.json();
    const text = picked.provider === "anthropic"
      ? (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("")
      : data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) return fail(res, 502, "empty_completion", "The model returned no text.");
    return res.json({ text, model: picked.id });
  }

  /* Normalise both vendors' event streams to one shape, so the browser has no
     provider-specific code: {delta} … then {done,text} or {error}. */
  res.set({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  let buffer = "", full = "";
  try {
    for await (const chunk of upstream.body) {
      buffer += chunk.toString("utf8");
      let cut;
      while ((cut = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt; try { evt = JSON.parse(payload); } catch { continue; }
        let delta = "";
        if (picked.provider === "anthropic") {
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") delta = evt.delta.text || "";
          if (evt.type === "error") { send({ error: { code: "upstream_error", message: evt.error?.message || "Stream error." } }); return res.end(); }
        } else {
          delta = evt.choices?.[0]?.delta?.content || "";
        }
        if (delta) { full += delta; send({ delta }); }
      }
    }
    send({ done: true, text: full });
  } catch (e) {
    send({ error: { code: "upstream_error", message: e.message } });
  }
  res.end();
});

/* -------------------------------------------------------------- POST /check */
const CHECK_PROVIDERS = {
  anthropic: {
    label: "Claude",
    model: () => process.env.ANTHROPIC_CHECK_MODEL || process.env.ANTHROPIC_MODEL_DEFAULT || "claude-sonnet-5",
  },
  openai: {
    label: "ChatGPT",
    model: () => process.env.OPENAI_CHECK_MODEL || process.env.OPENAI_MODEL_DEFAULT || "gpt-4o-mini",
  },
  gemini: {
    label: "Gemini",
    /* Gemini 2.5 Flash has a developer API free tier. An environment override
       keeps the deployment easy to move if Google changes its free models. */
    model: () => process.env.GEMINI_CHECK_MODEL || "gemini-2.5-flash",
  },
};

function parseJsonReply(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)); } catch {} }
  return null;
}

function checkPrompt(claim, reference) {
  return `You are one independent AI reviewer assisting a human fact-checker. Assess the claim below. You do not have live web access in this request, so never imply that you searched or verified a source. Distinguish established knowledge from uncertainty.\n\nCLAIM:\n${claim}\n${reference ? `\nREFERENCE MATERIAL:\n${reference}\n` : ""}\nReturn only JSON with this exact shape: {"assessment":"supported"|"uncertain"|"doubtful","reason":"one concise sentence that names the basis and its limits","what_to_check":"the single most decisive source or fact a human should check"}.`;
}

async function runProviderCheck(provider, prompt) {
  const spec = CHECK_PROVIDERS[provider];
  const apiKey = process.env[PROVIDER_KEY_NAMES[provider]];
  const model = spec.model();
  let upstream;
  if (provider === "anthropic") {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 800, temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });
  } else if (provider === "openai") {
    upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0, max_completion_tokens: 800, messages: [{ role: "user", content: prompt }] }),
    });
  } else {
    upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ model, input: prompt, store: false, generation_config: { max_output_tokens: 800, thinking_level: "low" } }),
    });
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    let message = "";
    try { message = JSON.parse(detail)?.error?.message || ""; } catch { message = detail.slice(0, 300); }
    const err = new Error(message || `${spec.label} returned ${upstream.status}.`);
    err.status = upstream.status;
    throw err;
  }

  const data = await upstream.json();
  const text = provider === "anthropic"
    ? (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("")
    : provider === "openai"
      ? data.choices?.[0]?.message?.content || ""
      : (data.steps || []).filter((s) => s.type === "model_output").flatMap((s) => s.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = parseJsonReply(text);
  if (!parsed) {
    const err = new Error(`${spec.label} returned an answer the workbench could not read.`);
    err.status = 502;
    throw err;
  }
  return { result: parsed, model, label: spec.label };
}

app.post("/api/check", rateLimit({ windowMs: 60_000, max: 30, key: "checks" }), async (req, res) => {
  const provider = String(req.body?.provider || "");
  const spec = CHECK_PROVIDERS[provider];
  if (!spec) return fail(res, 400, "invalid_request", "Choose Claude, ChatGPT, or Gemini.");
  if (!hasKey(provider)) return fail(res, 503, "not_configured", `${spec.label} is not connected. Add ${PROVIDER_KEY_NAMES[provider]} in Render.`);

  const claim = String(req.body?.claim || "").trim().slice(0, 8000);
  const reference = String(req.body?.reference || "").trim().slice(0, 8000);
  if (!claim) return fail(res, 400, "invalid_request", "A claim is required.");

  try {
    const checked = await runProviderCheck(provider, checkPrompt(claim, reference));
    const assessment = ["supported", "uncertain", "doubtful"].includes(checked.result.assessment)
      ? checked.result.assessment : "uncertain";
    res.json({
      provider,
      label: checked.label,
      model: checked.model,
      assessment,
      reason: String(checked.result.reason || "No reason was provided.").slice(0, 1200),
      what_to_check: String(checked.result.what_to_check || "Find an authoritative independent source.").slice(0, 1200),
    });
  } catch (e) {
    const status = e.status === 429 ? 429 : 502;
    const code = e.status === 401 || e.status === 403 ? "auth_failed" : e.status === 429 ? "rate_limited" : "upstream_error";
    fail(res, status, code, e.message);
  }
});

/* ------------------------------------------------------------- GET /audits */
app.get("/api/audits", async (req, res) => {
  if (!archiveOn()) return res.json({ archive: false, audits: [] });
  const { data, error } = await supa
    .from("audits")
    .select("id,title,created_at,verdict,judge_avg,claim_count,cleared_count,model_label,run_model,payload")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return fail(res, 500, "db_error", error.message);
  res.json({
    archive: true,
    audits: (data || []).map((r) => ({
      id: r.id, title: r.title, createdAt: r.created_at, verdict: r.verdict,
      judge: r.judge_avg, claimCount: r.claim_count, cleared: r.cleared_count,
      modelLabel: r.model_label, appliedTier: r.run_model,
      payload: typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload || {}),
    })),
  });
});

/* ------------------------------------------------------------ POST /audits */
app.post("/api/audits", rateLimit({ windowMs: 60_000, max: 60, key: "writes" }), async (req, res) => {
  if (!archiveOn()) return fail(res, 503, "no_archive", "No database is configured for this deployment.");
  const a = req.body || {};
  let state = {};
  try { state = typeof a.payload === "string" ? JSON.parse(a.payload) : (a.payload || {}); } catch { state = {}; }

  const cfg = state.cfg || {};
  const row = {
    title: String(a.title || "Untitled audit").slice(0, 300),
    created_by: String(a.createdBy || "").slice(0, 120) || null,
    model_label: String(a.modelLabel || "").slice(0, 120) || null,
    response: state.response || null,
    prompt: state.prompt || null,
    question: state.question || null,
    answer: state.answer || null,
    proof_standard: cfg.proof ?? null,
    granularity: cfg.gran || null,
    strictness: cfg.strict || null,
    pass_mark: cfg.pass ?? null,
    temperature: cfg.temp ?? null,
    run_model: a.appliedTier || cfg.tier || null,
    top_k: cfg.topK ?? null,
    min_match: cfg.minMatch ?? null,
    verdict: a.verdict || null,
    judge_avg: a.judge ?? null,
    claim_count: Number(a.claimCount) || 0,
    cleared_count: Number(a.cleared) || 0,
    payload: state,
  };

  const { data: ins, error } = await supa.from("audits").insert(row).select("id").single();
  if (error) return fail(res, 500, "db_error", error.message);
  const auditId = ins.id;

  /* Claims and scores go in as their own rows. This is the whole point — a blob
     cannot answer "which claim types get refuted". */
  const claims = (state.claims || []).map((c, i) => ({
    audit_id: auditId, position: i + 1,
    text: String(c.text || "").slice(0, 4000),
    claim_type: c.type || null, risk: c.risk || null,
    status: c.status || "unverified",
    tick_claim: !!(c.checks && c.checks.claim),
    tick_citation: !!(c.checks && c.checks.citation),
    tick_independent: !!(c.checks && c.checks.independent),
    source_url: c.url || null, note: c.note || null,
  }));
  if (claims.length) {
    const { error: cErr } = await supa.from("claims").insert(claims);
    if (cErr) {
      await supa.from("audits").delete().eq("id", auditId);
      return fail(res, 500, "db_error", `The audit was not saved because its claims could not be stored: ${cErr.message}`);
    }
  }

  const rubricName = {};
  (state.rubric || []).forEach((r) => { rubricName[r.id] = r.name; });
  const scores = (state.scores || []).map((s) => ({
    audit_id: auditId, criterion: s.criterion || null,
    criterion_name: rubricName[s.criterion] || s.criterion || null,
    score: s.score ?? null, justification: s.justification || null,
  }));
  if (scores.length) {
    const { error: sErr } = await supa.from("scores").insert(scores);
    if (sErr) {
      await supa.from("audits").delete().eq("id", auditId);
      return fail(res, 500, "db_error", `The audit was not saved because its scores could not be stored: ${sErr.message}`);
    }
  }

  res.status(201).json({ id: auditId });
});

/* --------------------------------------------------------- DELETE /audits */
app.delete("/api/audits/:id", rateLimit({ windowMs: 60_000, max: 30, key: "writes" }), async (req, res) => {
  if (!archiveOn()) return fail(res, 503, "no_archive", "No database is configured for this deployment.");
  if (!/^[0-9a-fA-F-]{10,64}$/.test(req.params.id)) return fail(res, 400, "invalid_request", "Bad audit id.");
  const { error } = await supa.from("audits").delete().eq("id", req.params.id); // claims and scores cascade
  if (error) return fail(res, 500, "db_error", error.message);
  res.json({ deleted: 1 });
});

/* ------------------------------------------------------------ GET /reports */
app.get("/api/reports", async (req, res) => {
  if (!archiveOn()) return res.json({ archive: false });
  try {
    const [types, models, discipline, weekly, totals, claims] = await Promise.all([
      supa.from("v_claim_type_quality").select("*"),
      supa.from("v_model_quality").select("*"),
      supa.from("v_review_discipline").select("*").single(),
      supa.from("v_audits_weekly").select("*"),
      supa.from("audits").select("id,judge_avg,claim_count,cleared_count"),
      supa.from("claims").select("status"),
    ]);
    const err = [types, models, discipline, weekly, totals, claims].find((r) => r.error);
    if (err) return fail(res, 500, "db_error", err.error.message);

    const auditRows = totals.data || [];
    const judged = auditRows.filter((r) => r.judge_avg != null);
    const byStatus = { verified: 0, unsupported: 0, refuted: 0, unverified: 0 };
    (claims.data || []).forEach((c) => { if (byStatus[c.status] != null) byStatus[c.status]++; });

    res.json({
      archive: true,
      totals: {
        audits: auditRows.length,
        claims: (claims.data || []).length,
        cleared: byStatus.verified,
        avgJudge: judged.length ? judged.reduce((s, r) => s + Number(r.judge_avg), 0) / judged.length : null,
      },
      byStatus,
      claimTypes: types.data || [],
      models: models.data || [],
      discipline: discipline.data || null,
      weekly: weekly.data || [],
    });
  } catch (e) {
    fail(res, 500, "db_error", e.message);
  }
});

/* ------------------------------------------------------------------ health */
app.get("/healthz", (req, res) =>
  res.json({ ok: true, protected: accessProtected(), archive: archiveOn(), anthropic: hasKey("anthropic"), openai: hasKey("openai"), gemini: hasKey("gemini") }));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`RAB listening on ${PORT}`);
    if (!archiveOn()) console.warn("No SUPABASE_URL / SUPABASE_SECRET_KEY — archive and reports are disabled.");
    if (!hasKey("anthropic") && !hasKey("openai") && !hasKey("gemini")) console.warn("No model API key set — AI steps are disabled.");
    if (!accessProtected()) console.warn("No RAB_USERNAME / RAB_PASSWORD — this deployment is public.");
  });
}

module.exports = app;
