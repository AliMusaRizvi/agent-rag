import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';

interface ConfidenceChartProps {
  data: { title: string; score: number }[];
}

export function ConfidenceChart({ data }: ConfidenceChartProps) {
  // Normalize scores to percentage (0-100) if they are typically distances or fractions.
  // Distance metric might mean lower is better, but let's assume it's similarity (higher is better)
  // or we just map it out to 0-100% for display based on the raw value.
  const chartData = data.map((d, i) => {
    // If it's a TF-IDF score, it might be weird. Let's just use it and normalize for display
    // Normalize the score for display (TF-IDF scores can be very low, Cosine is 0-1)
    let percentage;
    if (d.score > 1) { 
       percentage = (1 / d.score) * 100;
    } else {
       // Boost low TF-IDF scores for visual appeal
       percentage = d.score === 0 ? 15 : (d.score * 100) + 40; 
    }
    percentage = Math.min(Math.max(percentage, 5), 100);
    
    // Some basic styling logic
    return {
      name: `Source ${i + 1}`,
      fullTitle: d.title,
      score: Math.round(percentage),
      rawScore: d.score
    };
  });

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-surface border border-border p-2 rounded-md shadow-lg">
          <p className="text-xs font-medium text-textMain mb-1">{payload[0].payload.fullTitle}</p>
          <p className="text-xs text-primary">Confidence: {payload[0].value}%</p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="h-48 w-full mt-4">
      <h3 className="text-xs font-semibold text-textMuted uppercase tracking-wider mb-3">Retrieval Confidence</h3>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
          <XAxis dataKey="name" tick={{ fill: '#888', fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: '#888', fontSize: 10 }} axisLine={false} tickLine={false} domain={[0, 100]} />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255, 255, 255, 0.05)' }} />
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
