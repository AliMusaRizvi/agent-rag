import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import type { TooltipContentProps } from 'recharts';

interface ConfidenceChartProps {
  data: { title: string; score: number }[];
}

interface ChartDatum {
  name: string;
  fullTitle: string;
  score: number;
  rawScore: number;
}

// The backend's retrieval/rerank scores (vectorstore.js's fused RRF score,
// or rerank.js's LLM relevance score) are already a real 0-1 relevance
// value — there is nothing left to normalize or "boost". This used to
// synthesize a fake percentage (with a comment admitting as much) to make
// weak scores look better on the chart; that's gone.
function CustomTooltip({ active, payload }: TooltipContentProps) {
  if (active && payload && payload.length) {
    const point = payload[0].payload as ChartDatum;
    return (
      <div className="bg-surface border border-border p-2 rounded-md shadow-lg">
        <p className="text-xs font-medium text-textMain mb-1">{point.fullTitle}</p>
        <p className="text-xs text-primary">Relevance: {point.score}%</p>
      </div>
    );
  }
  return null;
}

export function ConfidenceChart({ data }: ConfidenceChartProps) {
  const chartData: ChartDatum[] = data.map((d, i) => ({
    name: `Source ${i + 1}`,
    fullTitle: d.title,
    score: Math.round(Math.min(Math.max(d.score, 0), 1) * 100),
    rawScore: d.score,
  }));

  return (
    <div className="h-48 w-full mt-4">
      <h3 className="text-xs font-semibold text-textMuted uppercase tracking-wider mb-3">Retrieval Relevance</h3>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
          <XAxis dataKey="name" tick={{ fill: '#888', fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: '#888', fontSize: 10 }} axisLine={false} tickLine={false} domain={[0, 100]} />
          <Tooltip content={CustomTooltip} cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }} />
          <Bar dataKey="score" radius={[4, 4, 0, 0]}>
            {chartData.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.score > 70 ? '#10b981' : entry.score > 40 ? '#f59e0b' : '#ef4444'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
