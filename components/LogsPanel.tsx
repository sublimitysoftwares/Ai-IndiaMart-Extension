/// <reference types="chrome" />
import React, { useEffect, useRef, useState } from 'react';

const SUMMARIES_KEY = 'indiamart_summaries';
const DIAGNOSTICS_KEY = 'indiamart_diagnostics';

interface LogsPanelProps {
  onClose?: () => void;
}

export const LogsPanel: React.FC<LogsPanelProps> = ({ onClose }) => {
  const [summaries, setSummaries] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState<string>('');
  const [filter, setFilter] = useState<string>('');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [paused, setPaused] = useState<boolean>(false);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());
  const containerRef = useRef<HTMLDivElement>(null);

  const loadLogs = () => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    chrome.storage.local.get([SUMMARIES_KEY, DIAGNOSTICS_KEY], (result) => {
      const sums: string[] = Array.isArray(result[SUMMARIES_KEY]) ? result[SUMMARIES_KEY] : [];
      const diag: string = result[DIAGNOSTICS_KEY] || '';
      if (!paused) {
        setSummaries(sums);
        setDiagnostics(diag);
        setLastUpdated(Date.now());
      }
    });
  };

  useEffect(() => {
    loadLogs();

    // Listen for storage changes
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      const handleChange: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, areaName) => {
        if (areaName !== 'local' || paused) return;
        if (changes[SUMMARIES_KEY]) {
          const sums: string[] = Array.isArray(changes[SUMMARIES_KEY].newValue) ? changes[SUMMARIES_KEY].newValue : [];
          setSummaries(sums);
          setLastUpdated(Date.now());
        }
        if (changes[DIAGNOSTICS_KEY]) {
          setDiagnostics(changes[DIAGNOSTICS_KEY].newValue || '');
          setLastUpdated(Date.now());
        }
      };
      chrome.storage.onChanged.addListener(handleChange);

      // Also listen for explicit LOGS_UPDATED broadcast
      const messageListener = (message: any) => {
        if (message?.type === 'LOGS_UPDATED' && !paused) {
          loadLogs();
        }
      };
      chrome.runtime?.onMessage.addListener(messageListener);

      return () => {
        chrome.storage.onChanged.removeListener(handleChange);
        chrome.runtime?.onMessage.removeListener(messageListener);
      };
    }
  }, [paused]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [summaries, diagnostics, showHistory, showDiagnostics, autoScroll]);

  const clearLogs = () => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    chrome.storage.local.set({ [SUMMARIES_KEY]: [], [DIAGNOSTICS_KEY]: '' }, () => loadLogs());
  };

  const exportLogs = () => {
    const body = [
      '=== Summaries ===',
      ...(summaries.length ? summaries : ['<none>']),
      '',
      '=== Diagnostics ===',
      diagnostics || '<none>'
    ].join('\n');
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `indiamart_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const latestSummary = summaries.length ? summaries[summaries.length - 1] : '';
  const historySummaries = showHistory ? summaries.slice().reverse().join('\n\n') : latestSummary;
  const mainText = React.useMemo(() => {
    const source = showHistory ? historySummaries : latestSummary;
    if (!filter.trim()) return source || 'No summaries yet.';
    const lines = (source || '').split('\n');
    return lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())).join('\n') || 'No match.';
  }, [historySummaries, latestSummary, showHistory, filter]);

  return (
    <div className="p-3 bg-slate-900 text-slate-200">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold">Realtime Logs</h3>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-400">Updated {new Date(lastUpdated).toLocaleTimeString()}</span>
          <button onClick={() => setPaused((p) => !p)} className="px-2 py-1 text-[11px] rounded bg-slate-700 hover:bg-slate-600">
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={clearLogs} className="px-2 py-1 text-[11px] rounded bg-red-700 hover:bg-red-600">Clear</button>
          <button onClick={exportLogs} className="px-2 py-1 text-[11px] rounded bg-indigo-700 hover:bg-indigo-600">Export</button>
          {onClose && (
            <button onClick={onClose} className="px-2 py-1 text-[11px] rounded bg-slate-700 hover:bg-slate-600">Close</button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <input
          placeholder="Search logs..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <label className="flex items-center gap-1 text-[11px] text-slate-300">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          Auto-scroll
        </label>
        <label className="flex items-center gap-1 text-[11px] text-slate-300">
          <input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} />
          Show history
        </label>
        <label className="flex items-center gap-1 text-[11px] text-slate-300">
          <input type="checkbox" checked={showDiagnostics} onChange={(e) => setShowDiagnostics(e.target.checked)} />
          Show diagnostics
        </label>
      </div>
      <div ref={containerRef} className="h-64 overflow-auto bg-slate-950 border border-slate-800 rounded p-2 text-[11px] whitespace-pre-wrap">
        {showDiagnostics ? (diagnostics || 'No diagnostics.') : (mainText)}
      </div>
    </div>
  );
};


