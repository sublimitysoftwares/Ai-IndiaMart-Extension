// Fix: Added a triple-slash directive to include TypeScript types for the Chrome extension API.
/// <reference types="chrome" />

import React, { useState, useEffect } from 'react';
import type { Lead } from './types';
import { LeadCard } from './components/LeadCard';
import { LogsPanel } from './components/LogsPanel';

enum AppState {
  Idle,
  Loading,
  LeadsScraped,
  Error,
  AutoContact,
}

interface AutoContactStats {
  totalContacted: number;
  totalFiltered: number;
  sessionStartTime: number;
}

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.Idle);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filteredLeads, setFilteredLeads] = useState<Lead[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'time' | 'company'>('time');
  const [autoContactEnabled, setAutoContactEnabled] = useState(true);
  const [agentStopped, setAgentStopped] = useState(false);
  const [autoContactStats, setAutoContactStats] = useState<AutoContactStats>({
    totalContacted: 0,
    totalFiltered: 0,
    sessionStartTime: Date.now()
  });
  const [showFilterDetails, setShowFilterDetails] = useState(false);
  const [agentInitialized, setAgentInitialized] = useState(false);
  const agentStoppedRef = React.useRef(false);
  const [showLogs, setShowLogs] = useState(false);

  const sortedLeads = React.useMemo(() => {
    const arr = [...leads];
    if (arr.length === 0) return arr;
    switch (sortBy) {
      case 'time': {
        const toTime = (t?: string) => {
          if (!t) return 0;
          const d = new Date(t);
          return isNaN(d.getTime()) ? 0 : d.getTime();
        };
        return arr.sort((a, b) => toTime(b.timestamp) - toTime(a.timestamp));
      }
      case 'company':
        return arr.sort((a, b) => (a.companyName || '').localeCompare(b.companyName || ''));
      default:
        return arr;
    }
  }, [leads, sortBy]);

  useEffect(() => {
    // Ensure this code runs only within a Chrome extension context
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.sendMessage({ type: 'GET_AGENT_STATUS' }, (response) => {
        if (!response || response.success === false) {
          return;
        }

        if (response.agentStopped) {
          setAgentStopped(true);
          agentStoppedRef.current = true;
          setAgentInitialized(false);
          setLeads([]);
          setFilteredLeads([]);
          setAutoContactEnabled(Boolean(response.autoContactEnabled));
          setAppState(AppState.Idle);
          return;
        }

        if (response.agentActive && response.leadsPayload) {
          setLeads(response.leadsPayload.allLeads || []);
          setFilteredLeads(response.leadsPayload.filteredLeads || []);
          setAutoContactEnabled(Boolean(response.autoContactEnabled));
          setAutoContactStats((prev) => ({
            ...prev,
            totalFiltered: response.leadsPayload.filteredLeads?.length || prev.totalFiltered,
            totalContacted: response.statistics?.totalContacted || prev.totalContacted,
          }));
          setAgentStopped(Boolean(response.agentStopped));
          agentStoppedRef.current = Boolean(response.agentStopped);
          setAgentInitialized(true);
          setAppState(response.autoContactEnabled ? AppState.AutoContact : AppState.LeadsScraped);
        } else {
          setAgentInitialized(false);
          setAutoContactEnabled(response?.autoContactEnabled ?? true);
          setAppState(AppState.Idle);
        }
      });

      const messageListener = (message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
        if (message.type === 'LEADS_DATA') {
          if (agentStoppedRef.current) {
            return;
          }
          if (message.payload && message.payload.length > 0) {
            setLeads(message.payload);
            setAppState(AppState.LeadsScraped);
            setAgentInitialized(true);
            setAgentStopped(false);
            agentStoppedRef.current = false;
          } else {
            setError("No leads found on the page. Please ensure you are on the 'Buy Leads' page and leads are visible.");
            setAppState(AppState.Error);
            setAgentInitialized(false);
          }
        } else if (message.type === 'FILTERED_LEADS_DATA') {
          if (agentStoppedRef.current) {
            return;
          }
          if (message.payload) {
            setLeads(message.payload.allLeads || []);
            setFilteredLeads(message.payload.filteredLeads || []);
            setAppState(autoContactEnabled ? AppState.AutoContact : AppState.LeadsScraped);
            setAgentInitialized(true);
            setAgentStopped(false);
            agentStoppedRef.current = false;
            setAutoContactStats(prev => ({
              ...prev,
              totalFiltered: message.payload.filteredLeads?.length ?? prev.totalFiltered
            }));
          }
        } else if (message.type === 'AUTO_CONTACT_UPDATE') {
          if (!agentStoppedRef.current) {
            // Update stats when a lead is contacted
            setAutoContactStats(prev => ({
              ...prev,
              totalContacted: message.statistics?.totalContacted || prev.totalContacted + 1
            }));
          }
        } else if (message.type === 'SCRAPING_ERROR') {
            setError(message.error);
            setAppState(AppState.Error);
            setAgentInitialized(false);
        } else if (message.type === 'AGENT_READY') {
            setAgentInitialized(true);
            setAgentStopped(false);
            agentStoppedRef.current = false;
        } else if (message.type === 'STOP_AGENT') {
            setAgentInitialized(false);
            setAgentStopped(true);
            setAutoContactEnabled(false);
            setAppState(AppState.Idle);
            setLeads([]);
            setFilteredLeads([]);
            agentStoppedRef.current = true;
        }
      };

      chrome.runtime.onMessage.addListener(messageListener);

      return () => {
        // Check again in case the context is lost during cleanup
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
           chrome.runtime.onMessage.removeListener(messageListener);
        }
      };
    } else {
        // This handles cases where the popup is opened in a non-extension context (e.g., local development server)
        setError("This application must be run as a Chrome extension.");
        setAppState(AppState.Error);
    }
  }, []);

  const handleStartAgent = () => {
     // Ensure this code runs only within a Chrome extension context
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        setError(null);
        if (!agentInitialized) {
          setAppState(AppState.Loading);
        }
        chrome.runtime.sendMessage({ type: 'START_AGENT' }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('START_AGENT error:', chrome.runtime.lastError.message);
            setError('Failed to start agent. Please try again.');
            setAppState(AppState.Error);
            return;
          }

          if (response && response.success) {
            setAgentStopped(false);
            agentStoppedRef.current = false;
            if (response.leadsPayload) {
              setLeads(response.leadsPayload.allLeads || []);
              setFilteredLeads(response.leadsPayload.filteredLeads || []);
              setAutoContactEnabled(Boolean(response.autoContactEnabled));
              setAgentInitialized(true);
              setAppState(response.autoContactEnabled ? AppState.AutoContact : AppState.LeadsScraped);
            } else if (!agentInitialized) {
              // Wait for content script to report back
              setAppState(AppState.Loading);
            }
          }
        });
    } else {
        setError("Cannot communicate with the extension background script. Are you running this as an extension?");
        setAppState(AppState.Error);
    }
  };
  
  const handleToggleAutoContact = () => {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      const newState = !autoContactEnabled;
      setAutoContactEnabled(newState);
      setAgentStopped(false);
      agentStoppedRef.current = false;
      
      if (newState) {
        setAppState(AppState.AutoContact);
        chrome.runtime.sendMessage({ type: 'ENABLE_AUTO_CONTACT' });
        // Reset stats when enabling
        setAutoContactStats({
          totalContacted: 0,
          totalFiltered: 0,
          sessionStartTime: Date.now()
        });
      } else {
        setAppState(AppState.LeadsScraped);
        chrome.runtime.sendMessage({ type: 'DISABLE_AUTO_CONTACT' });
      }
    }
  };
  
  const handleStopAgent = () => {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      setAgentStopped(true);
      agentStoppedRef.current = true;
      setAutoContactEnabled(false);
      setLeads([]);
      setFilteredLeads([]);
      setAppState(AppState.Idle);
      chrome.runtime.sendMessage({ type: 'STOP_AGENT' });
    }
  };

  useEffect(() => {
    agentStoppedRef.current = agentStopped;
  }, [agentStopped]);

  const renderContent = () => {
    switch (appState) {
      case AppState.Loading:
        return (
          <div className="flex flex-col items-center justify-center text-center p-6">
            <svg className="animate-spin h-8 w-8 text-indigo-400 mb-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <p className="text-lg font-medium text-slate-300">Opening IndiaMART & Scouring for Leads...</p>
            <p className="text-sm text-slate-400 mt-1">Please wait, the agent is at work.</p>
          </div>
        );
      case AppState.LeadsScraped:
      case AppState.AutoContact:
        return (
          <div>
            <div className="p-4 bg-slate-800/50 sticky top-0 backdrop-blur-sm z-10 border-b border-slate-700">
               <h2 className="text-lg font-bold text-white text-center">Found {leads.length} Leads</h2>
               
               {/* Auto-Contact Toggle & Controls */}
               <div className="mt-3 p-3 bg-slate-900 rounded-lg border border-slate-700">
                 <div className="flex items-center justify-between mb-2">
                   <span className="text-sm font-medium text-slate-300">Auto-Contact Mode</span>
                   <div className="flex items-center gap-2">
                     <button
                       onClick={handleToggleAutoContact}
                       disabled={agentStopped}
                       className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${autoContactEnabled ? 'bg-green-500' : 'bg-slate-600'} ${agentStopped ? 'opacity-50' : ''}`}
                     >
                       <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${autoContactEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                     </button>
                     {(autoContactEnabled || !agentStopped) && (
                       <button
                         onClick={handleStopAgent}
                         className="px-3 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded-md transition-colors"
                       >
                         Stop Agent
                       </button>
                     )}
                   </div>
                 </div>
                 
                 {autoContactEnabled && (
                   <div className="space-y-2 text-xs">
                     <div className="flex justify-between text-slate-400">
                       <span>Filtered Leads:</span>
                       <span className="text-green-400 font-bold">{filteredLeads.length}</span>
                     </div>
                     <div className="flex justify-between text-slate-400">
                       <span>Auto-Contacted:</span>
                       <span className="text-blue-400 font-bold">{autoContactStats.totalContacted} / {autoContactStats.totalFiltered}</span>
                     </div>
                     <div className="flex justify-between text-slate-400">
                       <span>Session Duration:</span>
                       <span className="text-slate-300">
                         {Math.floor((Date.now() - autoContactStats.sessionStartTime) / 60000)} min
                       </span>
                     </div>
                     <div className="flex justify-between text-slate-400">
                       <span>Refresh Status:</span>
                       <span className="text-yellow-400">
                         {filteredLeads.length === 0 ? 'In 5 min (no leads)' : 
                          autoContactStats.totalContacted >= autoContactStats.totalFiltered ? 'After all contacts' : 'Active'}
                       </span>
                     </div>
                   </div>
                 )}
                 
                 {agentStopped && (
                   <div className="mt-2 p-2 bg-red-900/20 rounded text-xs text-red-400 text-center">
                     Agent Stopped - Click "Start Agent" to resume
                   </div>
                 )}
               </div>
               
               {/* Filter Criteria Display */}
               <button
                 onClick={() => setShowFilterDetails(!showFilterDetails)}
                 className="w-full mt-2 text-xs text-slate-400 hover:text-slate-300 transition-colors"
               >
                 {showFilterDetails ? '▼' : '▶'} View Filter Criteria
               </button>
               
               {showFilterDetails && (
                 <div className="mt-2 p-2 bg-slate-900/50 rounded text-xs space-y-1 text-slate-400">
                   <div>✓ Keywords: Uniform, Blazers, Jackets, etc.</div>
                   <div>✓ Excluded: Delhi, Mumbai, Gurgaon, Ahmedabad, Surat, Thane</div>
                   <div>✓ Quantity: {'>'} 100 units</div>
                   <div>✓ Order Value: {'>'} ₹50,000</div>
                   <div>✓ Categories: School/Corporate/Hospital Uniforms</div>
                 </div>
               )}
               
               <div className="mt-3">
                 <label className="block text-sm text-slate-300 mb-1">Sort by</label>
                 <select
                   value={sortBy}
                   onChange={(e) => setSortBy(e.target.value as 'time' | 'company')}
                   className="w-full bg-slate-900 border border-slate-700 text-slate-200 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                 >
                   <option value="time">Time (newest first)</option>
                   <option value="company">Company (A–Z)</option>
                 </select>
               </div>
            </div>
            <div className="p-4 space-y-4">
              {(autoContactEnabled ? filteredLeads : sortedLeads).map((lead, index) => (
                <LeadCard key={index} lead={lead} />
              ))}
            </div>
          </div>
        );
      case AppState.Error:
        return (
          <div className="p-6 text-center">
            <h3 className="text-lg font-semibold text-red-400">An Error Occurred</h3>
            <p className="text-slate-300 mt-2">{error}</p>
            <button
                onClick={handleStartAgent}
                className="mt-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-900 focus:ring-indigo-500"
            >
              Try Again
            </button>
          </div>
        );
      case AppState.Idle:
      default:
        return (
          <div className="p-6 flex flex-col items-center space-y-3">
            <button
              onClick={handleStartAgent}
              className="w-full bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 text-white font-bold py-3 px-6 rounded-lg shadow-lg text-lg transform transition-transform duration-150 hover:scale-105"
            >
              Start Agent
            </button>
            <button
              onClick={handleStopAgent}
              className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 px-6 rounded-lg shadow text-sm transition-transform duration-150 hover:scale-105"
            >
              Stop Agent
            </button>
            <p className="text-sm text-slate-400 text-center">Click to open IndiaMART and automatically scrape the latest leads for analysis.</p>
          </div>
        );
    }
  };

  return (
    <div className="w-[450px] max-h-[600px] overflow-y-auto text-white bg-slate-900 font-sans">
      <header className="p-4 bg-slate-800 border-b border-slate-700">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-pink-500">
            IndiaMART Agent
          </h1>
          <button
            onClick={handleStopAgent}
            className="px-3 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded-md transition-colors"
          >
            Stop Agent
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => setShowLogs((v) => !v)}
            className="px-3 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-white rounded-md"
          >
            {showLogs ? 'Hide Logs' : 'Show Logs'}
          </button>
        </div>
      </header>
      <main>
        {showLogs && (
          <div className="border-b border-slate-800">
            <LogsPanel onClose={() => setShowLogs(false)} />
          </div>
        )}
        {renderContent()}
      </main>
    </div>
  );
};

export default App;
