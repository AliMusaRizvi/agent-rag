import { AlertTriangle, Check, X } from 'lucide-react';
import { ChatMessage } from '../types';

interface ApprovalCardProps {
  message: ChatMessage;
  onApprove: (approved: boolean) => void;
  disabled?: boolean;
}

export function ApprovalCard({ message, onApprove, disabled }: ApprovalCardProps) {
  const { actionStatus, actionResult, pending_tool_args } = message;

  if (actionStatus === 'approved' || actionStatus === 'rejected') {
    return (
      <div className="flex w-full animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex items-center gap-2 text-sm text-textMuted max-w-[85%]">
          {actionStatus === 'approved' ? (
            <Check size={16} className="text-green-500" />
          ) : (
            <X size={16} className="text-red-500" />
          )}
          <span>{actionResult || (actionStatus === 'approved' ? 'Action executed.' : 'Action cancelled.')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="max-w-[90%] w-full rounded-[20px] rounded-tl-[4px] bg-surface/50 backdrop-blur-sm border border-border/60 overflow-hidden shadow-lg">
        {/* Header */}
        <div className="px-4 py-3.5 bg-surface border-b border-border/60 flex items-center gap-2">
          <AlertTriangle size={18} className="text-warning" />
          <span className="text-sm font-medium text-textMain tracking-wide">Action Requires Approval</span>
        </div>
        
        {/* Body Fields */}
        <div className="p-4 space-y-4">
          {pending_tool_args && Object.entries(pending_tool_args).map(([key, value]) => {
            if (!value || key === 'action') return null; // internal identifier, not a field the approver needs to review
            return (
              <div key={key} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-textMuted uppercase tracking-wider">
                  {key}
                </span>
                {Array.isArray(value) ? (
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {value.map((v, i) => (
                      <span key={i} className="px-2 py-0.5 rounded bg-surfaceHover border border-border text-xs text-textMain">
                        {String(v)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-textMain bg-background border border-border rounded-lg p-2.5 max-h-32 overflow-y-auto custom-scrollbar font-mono whitespace-pre-wrap">
                    {String(value)}
                  </div>
                )}
              </div>
            );
          })}

          {!pending_tool_args && (
            <div className="text-sm text-textMuted italic">
              No tool arguments provided.
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-4 py-3 border-t border-border bg-background/50 flex items-center gap-3 justify-end">
          <button
            onClick={() => onApprove(false)}
            disabled={disabled}
            className="px-4 py-2 rounded-lg text-sm font-medium text-textMain hover:bg-surface border border-transparent hover:border-border transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Reject
          </button>
          <button
            onClick={() => onApprove(true)}
            disabled={disabled}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-primary hover:bg-primaryHover transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Approve Action
          </button>
        </div>
      </div>
    </div>
  );
}
