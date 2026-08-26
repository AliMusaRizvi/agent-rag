import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { ChatMessage } from "../types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
