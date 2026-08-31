import { config } from './config.js';

// Six layers, cheapest first. This module implements the input/output and
// retrieval-floor layers; the action-gating layer lives in graph.js and
// tools/github.js (allowlist + interrupt), and rate limiting/auth lives in
// security.js. Each function here is a heuristic, documented as such —
// upgrading to a trained classifier (e.g. a prompt-injection model, a real
// PII NER model) is a drop-in replacement for the matching function below.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_RE = /\b(?:\d[ -]*?){13,16}\b/g;
const API_KEY_RE = /\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|AIza|xox[baprs])-?[A-Za-z0-9_-]{16,}\b/g;

export function redactPII(text) {
  if (!text) return { redacted: text, hits: 0 };
  let hits = 0;
  const redacted = text
    .replace(API_KEY_RE, () => { hits++; return '[redacted-secret]'; })
    .replace(EMAIL_RE, () => { hits++; return '[redacted-email]'; })
    .replace(SSN_RE, () => { hits++; return '[redacted-ssn]'; })
    .replace(CREDIT_CARD_RE, (m) => {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 16) return m;
      hits++;
      return '[redacted-card]';
    })
    .replace(PHONE_RE, () => { hits++; return '[redacted-phone]'; });
  return { redacted, hits };
}

// Keyword/pattern heuristic, not a trained classifier — catches the common,
// unsubtle injection attempts ("ignore previous instructions") that make up
// the overwhelming majority of real-world attempts against a system like
// this, while flagging lower-confidence signals for logging rather than an
// automatic block (to avoid refusing legitimate questions about the topic
// of prompt injection itself).
const HIGH_CONFIDENCE_PATTERNS = [
  /ignore (all |any |the )?(previous|prior|above|earlier) instructions/i,
  /disregard (all |any |the )?(previous|prior|above|earlier) (instructions|rules|prompt)/i,
  /you are now[, ]+(?!.{0,3}(a |an )?(assistant|helpful))/i,
  /system prompt[:\s]/i,
  /reveal (your|the) (system prompt|instructions)/i,
  /new instructions?:/i,
  /\bDAN\b.{0,20}\bmode\b/i,
  /act as if you have no (restrictions|rules|guidelines)/i,
];

const MEDIUM_CONFIDENCE_PATTERNS = [
  /pretend (you are|to be)/i,
  /forget (everything|what) (you|i) (were|was) told/i,
  /override your (rules|guidelines|instructions)/i,
];

export function screenForInjection(text) {
  if (!text) return { blocked: false, confidence: 'none', matched: null };
  for (const re of HIGH_CONFIDENCE_PATTERNS) {
    if (re.test(text)) return { blocked: true, confidence: 'high', matched: re.source };
  }
  for (const re of MEDIUM_CONFIDENCE_PATTERNS) {
    if (re.test(text)) return { blocked: false, confidence: 'medium', matched: re.source };
  }
  return { blocked: false, confidence: 'none', matched: null };
}

// The single highest-leverage guardrail in RAG: refuse rather than
// generate from weak context. Threshold is on the fused RRF-derived score
// from vectorstore.hybridSearch (0..1, comparable across queries).
export function bestScoreBelowFloor(retrievedDocs) {
  if (retrievedDocs.length === 0) return true;
  const best = Math.max(...retrievedDocs.map((d) => d.fusedScore ?? 0));
  return best < config.MIN_RELEVANCE_SCORE;
}

// Drops any citation the model attached that doesn't actually correspond to
// a chunk it was given — the mechanical check that structured-output
// citations make possible (see GAP-04/GAP-05 in the audit: the old system
// let the model free-associate a "Sources:" list).
export function verifyCitations(citations, retrievedDocs) {
  const validIds = new Set(retrievedDocs.map((d) => d.id));
  return (citations || []).filter((c) => validIds.has(c.chunkId));
}

export function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max);
}
