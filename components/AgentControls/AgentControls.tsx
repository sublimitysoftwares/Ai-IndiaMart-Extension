import React from 'react';
import { AutoContactToggle } from './AutoContactToggle';
import { StatsDisplay } from './StatsDisplay';
import type { AutoContactStats, DailyContactStatsSummary } from '../../types';

interface AgentControlsProps {
  autoContactEnabled: boolean;
  agentStopped: boolean;
  filteredLeadsCount: number;
  stats: AutoContactStats;
  dailyStats?: DailyContactStatsSummary | null;
  backoffNotice?: string | null;
  onToggleAutoContact: () => void;
  onStopAgent: () => void;
  onDismissBackoff?: () => void;
}

export const AgentControls: React.FC<AgentControlsProps> = ({
  autoContactEnabled,
  agentStopped,
  filteredLeadsCount,
  stats,
  dailyStats,
  backoffNotice,
  onToggleAutoContact,
  onStopAgent,
  onDismissBackoff,
}) => {
  return (
    <div className="mt-3 p-3 bg-slate-900 rounded-lg border border-slate-700">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-slate-300">Auto-Contact Mode</span>
        <div className="flex items-center gap-2">
          <AutoContactToggle enabled={autoContactEnabled} onToggle={onToggleAutoContact} disabled={agentStopped} />
          {(autoContactEnabled || !agentStopped) && (
            <button
              onClick={onStopAgent}
              className="px-3 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded-md transition-colors"
            >
              Stop Agent
            </button>
          )}
        </div>
      </div>

      <StatsDisplay
        autoContactEnabled={autoContactEnabled}
        filteredLeadsCount={filteredLeadsCount}
        stats={stats}
        dailyStats={dailyStats}
        backoffNotice={backoffNotice}
        onDismissBackoff={onDismissBackoff}
      />

      {agentStopped && (
        <div className="mt-2 p-2 bg-red-900/20 rounded text-xs text-red-400 text-center">
          Agent Stopped - Click "Start Agent" to resume
        </div>
      )}
    </div>
  );
};