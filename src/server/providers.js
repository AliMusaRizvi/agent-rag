import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatGroq } from '@langchain/groq';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { ChatOllama } from '@langchain/ollama';
import { config } from './config.js';
import { logger } from './logger.js';

// One provider interface behind which every node in the graph calls a
// model. Swapping the default provider, or adding a new one, is a config
// change here — not a rewrite of every node that happens to call fetch()
// directly (which is what the old server.js did for its Gemini path).

// Every high-volume judgment call (routing, grading, rewriting, reranking,
// groundedness-checking) asks for the cheap/fast tier via `fast: true`.
// Each provider that has a meaningfully cheaper/faster model lists it here;
// providers without a separate fast tier just reuse their normal model.
const FAST_MODEL_BY_PROVIDER = {
  Groq: () => config.GROQ_FAST_MODEL,
  Ollama: () => config.OLLAMA_FAST_CHAT_MODEL,
  OpenRouter: () => config.OPENROUTER_FAST_MODEL,
};

const registry = {
  Ollama: {
    label: 'Ollama (local)',
    // No API key needed — only a reachable server, checked lazily at call
    // time (a Docker/network hiccup surfaces as a normal fallback-chain
    // warning, not a boot-time failure over something that might recover).
    available: true,
    build: (opts = {}) => new ChatOllama({
      baseUrl: config.OLLAMA_BASE_URL,
      model: config.OLLAMA_CHAT_MODEL,
      temperature: 0.2,
      ...opts,
    }),
  },
  Gemini: {
    label: 'Gemini',
    available: Boolean(config.geminiKey),
    build: (opts = {}) => new ChatGoogleGenerativeAI({
      apiKey: config.geminiKey,
      model: config.PRIMARY_LLM_MODEL,
      temperature: 0.2,
      ...opts,
    }),
  },
  Groq: {
    label: 'Groq',
    available: Boolean(config.GROQ_API_KEY),
    build: (opts = {}) => new ChatGroq({
      apiKey: config.GROQ_API_KEY,
      model: config.FALLBACK_LLM_MODEL,
      temperature: 0.2,
      ...opts,
    }),
  },
  Anthropic: {
    label: 'Anthropic',
    available: Boolean(config.ANTHROPIC_API_KEY),
    build: (opts = {}) => new ChatAnthropic({
      apiKey: config.ANTHROPIC_API_KEY,
      model: 'claude-sonnet-5',
      temperature: 0.2,
      ...opts,
    }),
  },
  OpenAI: {
    label: 'OpenAI',
    available: Boolean(config.OPENAI_API_KEY),
    build: (opts = {}) => new ChatOpenAI({
      apiKey: config.OPENAI_API_KEY,
      model: 'gpt-5.1',
      temperature: 0.2,
      ...opts,
    }),
  },
  OpenRouter: {
    label: 'OpenRouter',
    available: Boolean(config.OPENROUTER_API_KEY),
    // OpenRouter's API is OpenAI-compatible, so ChatOpenAI works unmodified
    // against it — just a different base URL. Chat only: verified live
    // that its embeddings endpoint exists but only proxies to paid models
    // (a real call returned 402 "insufficient credits"); its model catalog
    // has no embedding models at all, free or paid. See config.js for how
    // OPENROUTER_MODEL/OPENROUTER_FAST_MODEL were chosen and verified.
    build: (opts = {}) => new ChatOpenAI({
      apiKey: config.OPENROUTER_API_KEY,
      model: config.OPENROUTER_MODEL,
      temperature: 0.2,
      configuration: { baseURL: 'https://openrouter.ai/api/v1' },
      ...opts,
    }),
  },
};

// The order fallback attempts are tried in when the requested provider
// isn't the one that fails. Ollama first (free, local, no rate limits —
// the right default for a no-budget deployment), then the other free-tier
// cloud options (Groq, Gemini, OpenRouter); Anthropic/OpenAI are paid-key
// providers that only get tried if the user configured their own key.
const FALLBACK_ORDER = ['Ollama', 'Groq', 'Gemini', 'OpenRouter', 'Anthropic', 'OpenAI'];

// A model selection is either a bare provider id ("Groq") or a provider
// plus a specific model, separated by "::" — e.g.
// "OpenRouter::nvidia/nemotron-3-super-120b-a12b:free". A two-character
// separator is deliberate: OpenRouter's own ids already contain both "/"
// and ":" (the ":free" suffix), so a single-character one couldn't be
// split unambiguously.
export function parseModelSelection(value) {
  const raw = value || config.LLM_PROVIDER;
  const idx = String(raw).indexOf('::');
  if (idx === -1) return { providerId: normalizeModelType(raw), model: null };
  return {
    providerId: normalizeModelType(String(raw).slice(0, idx)),
    model: String(raw).slice(idx + 2) || null,
  };
}

// OpenRouter's free catalog changes as labs publish and retire models, so
// this is fetched live rather than hardcoded — the same reason config.js
// documents a re-verification command for the default. Cached because the
// model picker asks on every page load and the catalog is ~hundreds of KB.
// A fetch failure is not fatal: the picker simply falls back to offering
// OpenRouter as a single entry using OPENROUTER_MODEL.
const OPENROUTER_CATALOG_TTL_MS = 30 * 60 * 1000;
let openRouterCache = { at: 0, models: [] };

export async function listOpenRouterFreeModels() {
  if (!config.OPENROUTER_API_KEY) return [];
  if (Date.now() - openRouterCache.at < OPENROUTER_CATALOG_TTL_MS) return openRouterCache.models;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();

    const models = (body.data || [])
      .filter((m) => typeof m.id === 'string' && m.id.endsWith(':free'))
      // withStructuredOutput() needs native tool-calling or JSON mode. A
      // free model without either can chat but breaks every routing,
      // grading and citation call in the graph, so it is not offered.
      .filter((m) => {
        const p = m.supported_parameters || [];
        return p.includes('tools') || p.includes('response_format');
      })
      .map((m) => ({
        id: `OpenRouter::${m.id}`,
        label: (m.name || m.id).replace(/\s*\(free\)\s*$/i, ''),
        available: true,
        provider: 'OpenRouter',
        contextLength: m.context_length ?? null,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    openRouterCache = { at: Date.now(), models };
    return models;
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not fetch OpenRouter free-model catalog — offering the configured default only');
    return openRouterCache.models; // possibly stale, possibly empty; both are fine
  }
}

// Ollama needs a reachable server rather than a key, so unlike every other
// provider its availability can't be answered from config alone. The
// picker previously advertised it as available unconditionally, which on a
// deployment with no Ollama (Render, Railway) offered users a model that
// could only ever fail over to something else. Probed here with a short
// timeout and a brief cache, so the list reflects reality without adding a
// blocking check to boot.
const OLLAMA_PROBE_TTL_MS = 60 * 1000;
let ollamaProbe = { at: 0, reachable: false };

export async function isOllamaReachable() {
  if (Date.now() - ollamaProbe.at < OLLAMA_PROBE_TTL_MS) return ollamaProbe.reachable;
  let reachable = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const res = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  ollamaProbe = { at: Date.now(), reachable };
  return reachable;
}

export async function listModels() {
  const [freeOpenRouter, ollamaUp] = await Promise.all([
    listOpenRouterFreeModels(),
    isOllamaReachable(),
  ]);

  const providers = Object.entries(registry).map(([id, p]) => ({
    id,
    label: p.label,
    available: id === 'Ollama' ? ollamaUp : p.available,
    provider: id,
    // The bare OpenRouter entry means "use OPENROUTER_MODEL"; the
    // per-model entries below let a caller pin a specific one.
    contextLength: null,
  }));

  return [...providers, ...freeOpenRouter];
}

export function isAvailable(modelType) {
  return Boolean(registry[modelType]?.available);
}

function normalizeModelType(modelType) {
  // Absorb historical naming drift ("Grok", "Primary") and the old
  // Groq-as-default assumption into one canonical set, so callers never
  // have to guess which name is current.
  if (modelType === 'Grok') return 'Groq';
  if (modelType === 'Primary') return 'Gemini';
  if (!modelType) return config.LLM_PROVIDER;
  return modelType;
}

function chatModel(providerId, opts) {
  const entry = registry[providerId];
  if (!entry || !entry.available) return null;
  return entry.build(opts);
}

function fastOpts(providerId, fast) {
  if (!fast) return undefined;
  const getFastModel = FAST_MODEL_BY_PROVIDER[providerId];
  return getFastModel ? { model: getFastModel() } : undefined;
}

// Builds the ordered attempt list: the requested provider first, then
// every other configured provider in FALLBACK_ORDER, each de-duplicated.
// This replaces a hardcoded two-provider ping-pong (Groq<->Gemini) with a
// real chain — with Ollama in the mix as a third (now primary) option,
// a fixed pair no longer covers every "which one failed" case.
//
// When the caller pinned a specific model (e.g. a particular OpenRouter
// free model), that exact model is used for the FIRST attempt only. The
// fallbacks stay on each provider's own configured default, because a
// model id is meaningless outside the provider that serves it — asking
// Groq for "nvidia/nemotron-...:free" would just fail a second time.
function buildAttempts(modelType, { fast } = {}) {
  const { providerId, model: pinned } = parseModelSelection(modelType);
  const seen = new Set();
  const attempts = [];

  for (const id of [providerId, ...FALLBACK_ORDER]) {
    if (seen.has(id) || !isAvailable(id)) continue;
    seen.add(id);
    const isPrimary = id === providerId;
    const opts = isPrimary && pinned ? { model: pinned } : fastOpts(id, fast);
    attempts.push({ id, model: chatModel(id, opts) });
  }
  return attempts;
}

// Cloud providers that time out at 30s are almost always a real problem
// worth failing fast on. Ollama is CPU-bound local inference on whatever
// hardware it's running on — measured directly against this project's own
// dev machine (no GPU, 4 CPUs allocated), a structured-output call for a
// 3B model can genuinely take 60-90s. 30s there means the fallback chain
// fires on nearly every call instead of on real problems, which defeats
// the point of having a free local provider as the default. The fallback
// to a cloud provider on timeout is itself correct behavior (verified: it
// produces the same correct result, just faster) — this only changes how
// often Ollama gets a fair chance to finish on its own first.
function timeoutFor(providerId, explicit) {
  if (explicit != null) return explicit;
  return providerId === 'Ollama' ? 90_000 : 30_000;
}

// The fallback chain: try the requested model, then the other configured
// providers in priority order if the first call fails, times out, or is
// rate-limited. Wired once here — every node in graph.js and rerank.js
// goes through this, so an outage on one provider degrades gracefully
// everywhere instead of only in whichever nodes remembered to handle it.
export async function invokeChat(modelType, input, { timeoutMs, fast = false } = {}) {
  const attempts = buildAttempts(modelType, { fast });
  if (attempts.length === 0) {
    throw new Error(`No LLM provider is configured for "${modelType}", and no fallback is available either.`);
  }

  let lastErr;
  for (const attempt of attempts) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutFor(attempt.id, timeoutMs));
      const result = await attempt.model.invoke(input, { signal: controller.signal });
      clearTimeout(timer);
      return { content: result.content, modelUsed: attempt.id, usage: result.usage_metadata || null };
    } catch (err) {
      lastErr = err;
      logger.warn({ err: err.message, provider: attempt.id }, 'LLM call failed, trying next provider in the fallback chain');
    }
  }
  throw lastErr;
}

// Structured output with the same fallback chain. `schema` is a zod schema.
export async function invokeStructured(modelType, input, schema, { timeoutMs, name, fast = false } = {}) {
  const attempts = buildAttempts(modelType, { fast });
  if (attempts.length === 0) {
    throw new Error(`No LLM provider is configured for "${modelType}", and no fallback is available either.`);
  }

  let lastErr;
  for (const attempt of attempts) {
    try {
      const structuredModel = attempt.model.withStructuredOutput(schema, name ? { name } : undefined);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutFor(attempt.id, timeoutMs));
      const result = await structuredModel.invoke(input, { signal: controller.signal });
      clearTimeout(timer);
      return { data: result, modelUsed: attempt.id };
    } catch (err) {
      lastErr = err;
      logger.warn({ err: err.message, provider: attempt.id }, 'Structured LLM call failed, trying next provider');
    }
  }
  throw lastErr;
}

export { normalizeModelType };
