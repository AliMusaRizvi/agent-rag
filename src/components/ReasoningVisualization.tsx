import React, { useState } from 'react';
import { ChevronDown, Sparkles, Search, ShieldCheck, CheckCircle2, ChevronRight, CheckCircle, BrainCircuit } from 'lucide-react';
import { cn } from '../lib/utils';

interface ReasoningProps {
  reasoning: {
    attempts: number;
    verdict: string;
    trace?: string;
  };
  unverified?: boolean;
}

export function ReasoningVisualization({ reasoning, unverified }: ReasoningProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Parse trace into steps
  const rawTrace = reasoning.trace || "No internal reasoning trace provided.";
  const steps = rawTrace
    .replace(/([.?!])\s+(?=[A-Z])/g, "$1|")
    .split("|")
    .map(s => s.trim())
    .filter(s => s.length > 0);

  return (
    <div className="w-full mt-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full transition-all border",
          isOpen 
            ? "bg-surfaceHover border-border text-textMain" 
            : "bg-transparent border-border/50 text-textMuted hover:bg-surfaceHover/50 hover:text-textMain hover:border-border"
        )}
      >
        <BrainCircuit size={14} className={isOpen ? "text-primary" : "text-textMuted"} />
        {isOpen ? 'Hide reasoning process' : 'View reasoning process'}
        <ChevronDown size={14} className={cn("transition-transform duration-300", isOpen && "rotate-180")} />
      </button>

      {isOpen && (
        <div className="mt-3 p-4 rounded-xl bg-surface/50 border border-border/60 animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="relative">
            {/* Vertical Connecting Line */}
            <div className="absolute top-4 bottom-4 left-3 w-0.5 bg-border/50" />

            <div className="space-y-4">
              {/* Step 1: Retrieval */}
              <div className="relative flex gap-4">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-surface border border-border flex items-center justify-center z-10 text-textMuted">
                  <Search size={12} />
                </div>
                <div className="flex-1 pt-0.5">
                  <h4 className="text-xs font-semibold text-textMain mb-1">Knowledge Retrieval</h4>
                  <p className="text-xs text-textMuted">Completed in {reasoning.attempts} attempt(s).</p>
                </div>
              </div>

              {/* Step 2: Chain of Thought */}
              {steps.map((step, idx) => (
                <div key={idx} className="relative flex gap-4 group">
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-surface border border-border flex items-center justify-center z-10 text-primary">
                    <Sparkles size={12} />
                  </div>
                  <div className="flex-1 pt-0.5">
                    <h4 className="text-xs font-semibold text-textMain mb-1">Thought Process {idx + 1}</h4>
                    <p className="text-xs text-textMuted leading-relaxed">{step}</p>
                  </div>
                </div>
              ))}

              {/* Step 3: Verdict */}
              <div className="relative flex gap-4">
                <div className={cn(
                  "flex-shrink-0 w-6 h-6 rounded-full border flex items-center justify-center z-10",
                  unverified ? "bg-warning/10 border-warning text-warning" : "bg-green-500/10 border-green-500/30 text-green-500"
                )}>
                  {unverified ? <ShieldCheck size={12} /> : <CheckCircle2 size={12} />}
                </div>
                <div className="flex-1 pt-0.5">
                  <h4 className="text-xs font-semibold text-textMain mb-1">Verification Verdict</h4>
                  <p className={cn(
                    "text-xs",
                    unverified ? "text-warning" : "text-green-500"
                  )}>
                    {reasoning.verdict}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
