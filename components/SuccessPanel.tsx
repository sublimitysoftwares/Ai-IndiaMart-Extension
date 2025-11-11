/// <reference types="chrome" />
import React, { useEffect, useState } from 'react';

const CONTACT_SUCCESS_KEY = 'indiamart_contact_successes';

interface ContactSuccessEntry {
  leadId?: string;
  companyName?: string;
  enquiryTitle?: string;
  location?: string;
  contactedAt: string;
  probableOrderValue?: string;
}

interface SuccessPanelProps {
  onClose?: () => void;
}

export const SuccessPanel: React.FC<SuccessPanelProps> = ({ onClose }) => {
  const [successes, setSuccesses] = useState<ContactSuccessEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [lastUpdated, setLastUpdated] = useState(Date.now());

  const loadSuccesses = () => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    chrome.storage.local.get([CONTACT_SUCCESS_KEY], (result) => {
      const entries: ContactSuccessEntry[] = Array.isArray(result[CONTACT_SUCCESS_KEY])
        ? result[CONTACT_SUCCESS_KEY]
        : [];
      setSuccesses(entries.slice().reverse());
      setLastUpdated(Date.now());
    });
  };

  useEffect(() => {
    loadSuccesses();

    if (typeof chrome !== 'undefined') {
      const handleStorage: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, areaName) => {
        if (areaName !== 'local' || !changes[CONTACT_SUCCESS_KEY]) return;
        loadSuccesses();
      };
      chrome.storage?.onChanged.addListener(handleStorage);

      const handleMessage = (message: any) => {
        if (message?.type === 'CONTACT_SUCCESS_UPDATED') {
          loadSuccesses();
        }
      };
      chrome.runtime?.onMessage.addListener(handleMessage);

      return () => {
        chrome.storage?.onChanged.removeListener(handleStorage);
        chrome.runtime?.onMessage.removeListener(handleMessage);
      };
    }
  }, []);

  const filteredSuccesses = React.useMemo(() => {
    const normalized = filter.trim().toLowerCase();
    if (!normalized) return successes;
    return successes.filter((entry) => {
      const haystack = [
        entry.companyName,
        entry.enquiryTitle,
        entry.location,
        entry.probableOrderValue,
        entry.leadId,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalized);
    });
  }, [successes, filter]);

  return (
    <div className="p-3 bg-slate-900 text-slate-200 border-b border-slate-800">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold">Successful Contacts</h3>
          <p className="text-[11px] text-slate-400">
            Leads that passed all filters and had both actions completed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-400">
            Updated {new Date(lastUpdated).toLocaleTimeString()}
          </span>
          {onClose && (
            <button
              onClick={onClose}
              className="px-2 py-1 text-[11px] rounded bg-slate-700 hover:bg-slate-600"
            >
              Close
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search company, enquiry, location..."
          className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button
          onClick={loadSuccesses}
          className="px-2 py-1 text-[11px] rounded bg-slate-700 hover:bg-slate-600"
        >
          Refresh
        </button>
      </div>

      <div className="h-52 overflow-auto bg-slate-950 border border-slate-800 rounded p-2 space-y-2">
        {filteredSuccesses.length ? (
          filteredSuccesses.map((entry, index) => (
            <div
              key={`${entry.leadId || index}-${entry.contactedAt}`}
              className="border border-slate-800 rounded-md px-3 py-2 bg-slate-900/70"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">
                    {entry.companyName || 'Unknown Company'}
                  </p>
                  <p className="text-xs text-slate-300">
                    {entry.enquiryTitle || 'No enquiry title'}
                  </p>
                </div>
                <span className="text-[11px] text-slate-400">
                  {new Date(entry.contactedAt).toLocaleString()}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                <span>Location: {entry.location || 'N/A'}</span>
                {entry.probableOrderValue && (
                  <span className="text-emerald-400">Order Value: {entry.probableOrderValue}</span>
                )}
                {entry.leadId && <span>ID: {entry.leadId}</span>}
              </div>
            </div>
          ))
        ) : (
          <div className="text-[12px] text-slate-500 text-center mt-6">
            No successful contacts recorded yet.
          </div>
        )}
      </div>
    </div>
  );
};


