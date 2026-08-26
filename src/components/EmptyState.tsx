import React from 'react';
import { Lightbulb } from 'lucide-react';

interface EmptyStateProps {
  onSelectQuestion: (question: string) => void;
}

const exampleQuestions = [
  "What is our remote work policy?",
  "How do I file a hardware replacement ticket?",
  "Summarize the Q3 engineering goals.",
  "Deploy the latest staging release.", // To trigger approval flow
];

export function EmptyState({ onSelectQuestion }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-[50vh] text-center px-4 animate-in fade-in duration-700">
      <div className="w-12 h-12 rounded-2xl bg-surface border border-border flex items-center justify-center mb-6 shadow-sm">
        <Lightbulb className="text-textMuted" size={24} />
      </div>
      <h2 className="text-2xl font-semibold mb-2">How can I help you today?</h2>
      <p className="text-textMuted mb-8 max-w-md">
        I can answer questions based on the internal handbook, and help you execute routine operations.
      </p>
      
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg">
        {exampleQuestions.map((q, idx) => (
          <button
            key={idx}
            onClick={() => onSelectQuestion(q)}
            className="text-left px-4 py-3 rounded-xl bg-surface border border-border hover:border-primary/50 hover:bg-surfaceHover transition-colors text-sm text-textMain"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
