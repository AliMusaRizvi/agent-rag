import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

// Single source of truth for the environment. Boot fails loudly and immediately
// if something required is missing, instead of failing confusingly three
// requests later inside a random node.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // At least one generation provider is required — Ollama always counts
  // (see below), since it needs no API key, only a reachable server.
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),

  // Default provider for both chat and the graph's own defaults (state
  // channel default, chat.js's fallback when the client doesn't specify a
  // model). Ollama — free, local, no rate limits — is the right default
  // for a no-budget deployment; every other provider stays fully wired
  // in and is used automatically whenever its API key is present.
  LLM_PROVIDER: z.string().default('Ollama'),

  PRIMARY_LLM_MODEL: z.string().default('gemini-2.5-flash'),
  // Verified live against Groq's /models endpoint at build time — their
  // catalog turns over faster than most providers' (models get retired
  // with little notice), so this is deliberately read from config instead
  // of hardcoded inside providers.js. Re-verify before deploying if it's
  // been a while: `curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"`.
  FALLBACK_LLM_MODEL: z.string().default('openai/gpt-oss-120b'),
  GROQ_FAST_MODEL: z.string().default('openai/gpt-oss-20b'),

  // OpenRouter: an aggregator, not its own model — routes to whichever
  // lab actually serves the requested id. Chat only: verified live against
  // its own /api/v1/embeddings endpoint, which exists but only proxies to
  // paid models (a real request for one returned 402 "insufficient
  // credits") — its full model catalog has zero embedding models, free or
  // paid, so this is chat-only, the same treatment Groq gets and for the
  // same reason.
  //
  // Model choice verified live, twice, at integration time — not just
  // "exists in the catalog": both of Google's free Gemma releases (the
  // obvious first pick — new, well-known, and they do advertise
  // tools/tool_choice/response_format support) returned a live 429
  // "temporarily rate-limited upstream" from Google AI Studio's own shared
  // free-tier pool on every attempt. NVIDIA's Nemotron, tried next,
  // answered a real withStructuredOutput() call correctly in ~2.2s on two
  // separate tries; MiniMax's M3 (also tried) hung for minutes on the same
  // test and was dropped. Free-tier model availability on a shared
  // upstream pool shifts over time, so re-verify before deploying if it's
  // been a while — the exact command used here:
  // `curl https://openrouter.ai/api/v1/chat/completions -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" -d '{"model":"<id>","messages":[{"role":"user","content":"hi"}]}'`.
  OPENROUTER_MODEL: z.string().default('nvidia/nemotron-3-super-120b-a12b:free'),
  OPENROUTER_FAST_MODEL: z.string().default('nvidia/nemotron-3-super-120b-a12b:free'),

  // Ollama: self-hosted, zero cost, zero rate limits — the practical
  // choice for a portfolio project with no API budget. Needs an actual
  // Ollama server reachable at OLLAMA_BASE_URL (docker-compose.yml runs
  // one and pre-pulls these three models before the app starts).
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_CHAT_MODEL: z.string().default('llama3.2:3b'),
  // Deliberately the SAME model as OLLAMA_CHAT_MODEL, not a smaller one —
  // every other provider's "fast tier" (e.g. Groq's 20b vs 120b) is still
  // a genuinely capable model doing a cheaper job, but 1B-class models are
  // meaningfully less reliable at multi-step structured reasoning (the
  // router alone classifies AND rewrites the query AND may extract tool
  // arguments in one call), and RAG correctness was called out explicitly
  // as the bar here — not a place to trade reliability for latency. Bump
  // this back down only after actually measuring 1B's accuracy on this
  // pipeline's specific judgment calls, not on the assumption it's fine.
  OLLAMA_FAST_CHAT_MODEL: z.string().default('llama3.2:3b'),
  OLLAMA_EMBEDDING_MODEL: z.string().default('nomic-embed-text'),

  // Which embedding backend actually runs. 'ollama' needs no key and no
  // quota; 'gemini' is the paid-tier-adjacent option for anyone who does
  // have Gemini budget/quota (see embeddings.js for both implementations).
  EMBEDDING_PROVIDER: z.enum(['ollama', 'gemini']).default('ollama'),
  EMBEDDING_MODEL: z.string().default('models/gemini-embedding-001'),
  // Must match whatever EMBEDDING_PROVIDER's model actually returns, or
  // every Qdrant write is silently rejected with a dimension-mismatch
  // error — this exact bug shipped once already (see vectorstore.js's
  // startup dimension check, added after catching it against a real
  // Qdrant instance; the in-memory fallback never validates dimensions at
  // all, which is how it went undetected in the first place). Verified
  // live: nomic-embed-text returns 768-dim vectors; gemini-embedding-001
  // returns 3072 — change this if you change EMBEDDING_PROVIDER.
  EMBEDDING_DIM: z.coerce.number().int().positive().default(768),

  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_COLLECTION: z.string().default('enterprise_handbook'),
  VECTOR_BACKEND: z.enum(['auto', 'qdrant', 'memory']).default('auto'),

  POSTGRES_URL: z.string().optional(),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().optional(), // "owner/repo" — the only repo the tool is allowed to write to
  // The actual handbook source (Hugo site) — not gitlab-org/gitlab-foss,
  // which is the product's source code and has almost no markdown outside
  // /doc. Verified at ingest.js write time: gitlab-com/content-sites/handbook
  // has ~5,670 tree entries under content/handbook, the real majority of
  // them markdown pages.
  GITLAB_REPO: z.string().default('gitlab-com/content-sites/handbook'),
  GITLAB_DOCS_PATH: z.string().default('content/handbook'),

  LANGCHAIN_TRACING_V2: z.coerce.boolean().default(false),
  LANGCHAIN_PROJECT: z.string().default('enterprise-knowledge-agent'),
  LANGSMITH_API_KEY: z.string().optional(),

  // Security
  API_KEY: z.string().optional(), // shared bearer/x-api-key secret gating write routes
  ALLOWED_ORIGINS: z.string().optional(), // comma-separated
  SESSION_SECRET: z.string().default('dev-only-insecure-secret-change-me'),

  // Guardrails
  MIN_RELEVANCE_SCORE: z.coerce.number().min(0).max(1).default(0.28),
  MAX_REWRITES: z.coerce.number().int().min(0).max(5).default(2),
  MAX_REGENERATIONS: z.coerce.number().int().min(0).max(3).default(1),
  MAX_MESSAGE_LENGTH: z.coerce.number().int().positive().default(4000),
  MAX_SYSTEM_PROMPT_LENGTH: z.coerce.number().int().positive().default(800),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  DAILY_TOKEN_BUDGET_PER_SESSION: z.coerce.number().int().positive().default(200_000),
});

// Empty-string env vars (e.g. `EMBEDDING_DIM=` left blank in a copied
// .env.example) should fall through to the schema's default, not fail
// coercion as an empty/NaN value — dotenv and the shell both hand us
// "" for a declared-but-unset variable, never `undefined`.
const cleanedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== ''),
);

const parsed = schema.safeParse(cleanedEnv);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

// Ollama always counts as a configured provider — it needs a reachable
// server, not an API key, and reachability is checked lazily at call time
// (same treatment as Postgres/Qdrant) rather than blocking boot, since
// OLLAMA_BASE_URL always has a default value even when nothing is
// actually listening there yet.
const hasAnyCloudProvider = Boolean(
  env.GOOGLE_API_KEY || env.GEMINI_API_KEY || env.GROQ_API_KEY || env.ANTHROPIC_API_KEY
  || env.OPENAI_API_KEY || env.OPENROUTER_API_KEY,
);
if (env.LLM_PROVIDER !== 'Ollama' && !hasAnyCloudProvider) {
  console.error('Invalid environment configuration:');
  console.error('  - LLM_PROVIDER is not Ollama, and none of GOOGLE_API_KEY/GEMINI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY is set');
  process.exit(1);
}

const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || null;

if (env.EMBEDDING_PROVIDER === 'gemini' && !geminiKey) {
  console.error('Invalid environment configuration:');
  console.error('  - EMBEDDING_PROVIDER is "gemini" but neither GEMINI_API_KEY nor GOOGLE_API_KEY is set');
  process.exit(1);
}

export const config = {
  ...env,
  geminiKey,
  isProduction: env.NODE_ENV === 'production',
  allowedOrigins: env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : ['http://localhost:3000', 'http://localhost:5173'],
  hasGithubTool: Boolean(env.GITHUB_TOKEN && env.GITHUB_REPO),
  hasPostgres: Boolean(env.POSTGRES_URL),
  hasQdrant: Boolean(env.QDRANT_URL && env.QDRANT_API_KEY) || env.VECTOR_BACKEND === 'qdrant',
};

if (config.isProduction) {
  const insecureDefaults = [];
  if (!env.API_KEY) insecureDefaults.push('API_KEY');
  if (env.SESSION_SECRET === 'dev-only-insecure-secret-change-me') insecureDefaults.push('SESSION_SECRET');
  if (!config.hasPostgres) insecureDefaults.push('POSTGRES_URL (conversation state and audit log will not survive a restart)');
  if (insecureDefaults.length > 0) {
    console.error('Refusing to start in production with insecure/missing configuration:');
    insecureDefaults.forEach((k) => console.error(`  - ${k}`));
    process.exit(1);
  }
}
