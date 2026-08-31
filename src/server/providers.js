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
};

// The order fallback attempts are tried in when the requested provider
// isn't the one that fails. Ollama first (free, local, no rate limits —
// the right default for a no-budget deployment); paid/rate-limited cloud
// providers only get tried if they're actually configured.
const FALLBACK_ORDER = ['Ollama', 'Groq', 'Gemini', 'Anthropic', 'OpenAI'];

export function listModels() {
  return Object.entries(registry).map(([id, p]) => ({ id, label: p.label, available: p.available }));
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

function chatModel(modelType, opts) {
  const id = normalizeModelType(modelType);
  const entry = registry[id];
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
function buildAttempts(modelType, { fast } = {}) {
  const primaryId = normalizeModelType(modelType);
  const seen = new Set();
  const attempts = [];

  for (const id of [primaryId, ...FALLBACK_ORDER]) {
    if (seen.has(id) || !isAvailable(id)) continue;
    seen.add(id);
    attempts.push({ id, model: chatModel(id, fastOpts(id, fast)) });
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
