import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { ChatMessage } from "../types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// A corrupted or oversized entry (a bad manual edit, a previous version's
// incompatible shape, private-browsing storage that silently rejects
// writes) used to throw straight out of a useState initializer with no
// error boundary anywhere in the tree — one bad value white-screened the
// whole app on load. Every localStorage touch goes through these instead.
export function safeLocalStorageGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function safeLocalStorageSet(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function exportToMarkdown(messages: ChatMessage[], model: string) {
  let md = `# Enterprise Knowledge Agent Conversation\n`;
  md += `*Model: ${model}*\n`;
  md += `*Date: ${new Date().toLocaleString()}*\n\n`;
  md += `---\n\n`;

  messages.forEach(m => {
    md += `### ${m.role === 'user' ? 'User' : 'Agent'}\n`;
    if (m.isApprovalCard) {
      md += `*Action Pending Approval*\n`;
    } else {
      md += `${m.content}\n`;
    }
    md += '\n';
  });

  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `conversation-${new Date().getTime()}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
