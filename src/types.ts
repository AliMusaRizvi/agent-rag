export interface ToolArgs {
  action?: string;
  repo?: string;
  title: string;
  body: string;
  labels: string[];
  [key: string]: unknown;
}

export interface Citation {
  chunkId?: string;
  title: string;
  url: string;
  snippet?: string;
  denseScore?: number | null;
  sparseScore?: number | null;
  fusedScore?: number | null;
  rerankScore?: number | null;
  score?: number;
  cited?: boolean;
}

// One real entry from the LangGraph run's own trace — not a paraphrase.
// `detail` is node-specific (see src/server/graph.js's trace() calls for
// the exact shape each node writes).
export interface GraphTraceStep {
  node: string;
  detail: Record<string, unknown>;
  at: string;
}

export interface GraphTrace {
  path: string[]; // node names in actual execution order, repeats included when a loop fires
  steps: GraphTraceStep[];
  rewriteCount: number;
  regenerateCount: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  requires_approval?: boolean;
  pending_tool_args?: ToolArgs;
  unverified?: boolean; // If answer is low confidence
  citations?: Citation[];
  reasoning?: { attempts: number; verdict: string; trace?: string };
  graphTrace?: GraphTrace;
  modelUsed?: string;
  isApprovalCard?: boolean; // Whether to render as an approval card
  actionStatus?: 'pending' | 'approved' | 'rejected';
  actionResult?: string; // "Created issue: <url>"
  streamed?: boolean;
  feedback?: 'up' | 'down';
}

export interface ModelInfo {
  id: string;          // "Groq", or a pinned "OpenRouter::<model id>"
  label: string;
  available: boolean;
  provider?: string;   // which provider serves it — used to group the picker
  contextLength?: number | null;
}

export interface ChatThread {
  id: string;
  title: string;
  date: string;
  messages: ChatMessage[];
  model: string;
}
