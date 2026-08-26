export interface ToolArgs {
  title: string;
  body: string;
  labels: string[];
  [key: string]: any;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  requires_approval?: boolean;
  pending_tool_args?: ToolArgs;
  unverified?: boolean; // If answer is low confidence
  citations?: { title: string; url: string; snippet?: string; score?: number }[];
  reasoning?: { attempts: number; verdict: string };
  isApprovalCard?: boolean; // Whether to render as an approval card
  actionStatus?: 'pending' | 'approved' | 'rejected';
  actionResult?: string; // "Created issue: <url>"
  streamed?: boolean;
  feedback?: 'up' | 'down';
}

export interface ChatThread {
  id: string;
  title: string;
  date: string;
  messages: ChatMessage[];
  model: string;
}
