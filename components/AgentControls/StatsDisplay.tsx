import React from 'react';
import type { AutoContactStats, DailyContactStatsSummary } from '../../types';

interface StatsDisplayProps {
  autoContactEnabled: boolean;
  filteredLeadsCount: number;
  stats: AutoContactStats;
  dailyStats?: DailyContactStatsSummary | null;
  backoffNotice?: string | null;
  onDismissBackoff?: () => void;
}

export const StatsDisplay: React.FC<StatsDisplayProps> = ({
  autoContactEnabled,
  filteredLeadsCount,
  stats,
  dailyStats,
  backoffNotice,
  onDismissBackoff,
}) => {
  if (!autoContactEnabled) return null;

  return (
    <>
      <div className="space-y-2 text-xs">
        <div className="flex justify-between text-slate-400">
          <span>Filtered Leads:</span>
          <span className="text-green-400 font-bold">{filteredLeadsCount}</span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Auto-Contacted:</span>
          <span className="text-blue-400 font-bold">
            {stats.totalContacted} / {stats.totalFiltered}
          </span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Session Duration:</span>
          <span className="text-slate-300">
            {Math.floor((Date.now() - stats.sessionStartTime) / 60000)} min
          </span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Refresh Status:</span>
          <span className="text-yellow-400">
            {filteredLeadsCount === 0
              ? 'In 5 min (no leads)'
              : stats.totalContacted >= stats.totalFiltered
              ? 'After all contacts'
              : 'Active'}
          </span>
        </div>
      </div>
      {dailyStats && (
        <div className="mt-2 flex justify-between text-xs text-slate-400">
          <span>Daily Quota</span>
          <span
            className={
              dailyStats.count >= dailyStats.limit
                ? 'text-red-400 font-semibold'
                : 'text-green-400 font-semibold'
            }
          >
            {dailyStats.count} / {dailyStats.limit} ({dailyStats.date})
          </span>
        </div>
      )}
      {backoffNotice && (
        <div className="mt-2 p-2 bg-amber-900/30 border border-amber-500/40 rounded text-xs text-amber-100 flex items-center justify-between gap-2">
          <span>{backoffNotice}</span>
          {onDismissBackoff && (
            <button
              onClick={onDismissBackoff}
              className="text-amber-200 hover:text-white text-[10px] uppercase tracking-wide"
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </>
  );
};