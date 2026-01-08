// Fix: Added a triple-slash directive to include TypeScript types for the Chrome extension API.
/// <reference types="chrome" />

import React, { useState, useEffect } from 'react';
import type { Lead, FilterCriteria, AutoContactStats, DailyContactStatsSummary, CycleSummary } from './types';
import { AppState } from './types';
import { useAgentState } from './hooks/useAgentState';
import { useFilterConfig } from './hooks/useFilterConfig';
import { useLeads } from './hooks/useLeads';
import { LeadCard } from './components/LeadCard';
import { AgentControls } from './components/AgentControls/AgentControls';
import { SettingsPanel } from './components/Settings/SettingsPanel';
import { LeadsList } from './components/LeadsList/LeadsList';
import { FilterDetails } from './components/LeadsList/FilterDetails';
import { LoadingSpinner } from './components/LoadingStates/LoadingSpinner';

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [showFilterDetails, setShowFilterDetails] = useState(false);
  const [filterCriteria, setFilterCriteria] = useState<FilterCriteria | null>(null);

  // Use custom hooks for state management
  const {
    appState,
    setAppState,
    autoContactEnabled,
    setAutoContactEnabled,
    agentStopped,
    setAgentStopped,
    agentInitialized,
    setAgentInitialized,
    error,
    setError,
    autoContactStats,
    setAutoContactStats,
    dailyStats,
    setDailyStats,
    cycleSummary,
    setCycleSummary,
    backoffNotice,
    setBackoffNotice,
    agentStoppedRef,
    backoffTimerRef,
    handleStartAgent,
    handleToggleAutoContact,
    handleStopAgent,
  } = useAgentState();

  const { leads, setLeads, filteredLeads, setFilteredLeads, sortBy, setSortBy, sortedLeads } = useLeads();

  const {
    keywords,
    categories,
    newKeyword,
    setNewKeyword,
    newCategory,
    setNewCategory,
    quantityMin,
    setQuantityMin,
    quantityUnit,
    setQuantityUnit,
    orderValue,
    setOrderValue,
    settingsMessage,
    handleAddKeyword,
    handleRemoveKeyword,
    handleAddCategory,
    handleRemoveCategory,
    handleUpdateQuantity,
    handleUpdateOrderValue,
    handleExportConfig,
    handleImportConfig,
  } = useFilterConfig(filterCriteria, showSettings);

  // Storage change listener is handled by useFilterConfig hook
  
  useEffect(() => {
    // Ensure this code runs only within a Chrome extension context
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.sendMessage({ type: 'GET_AGENT_STATUS' }, (response) => {
        if (!response || response.success === false) {
          return;
        }
        
        // IMMEDIATE state updates (don't wait for async storage operations)
        // Always update auto-contact state from response first (before any conditional logic)
        if (typeof response.autoContactEnabled === 'boolean') {
          setAutoContactEnabled(response.autoContactEnabled);
        }
        
        // Update agent stopped state immediately
        setAgentStopped(Boolean(response.agentStopped));
        agentStoppedRef.current = Boolean(response.agentStopped);
        
        if (response.dailyStats) {
          setDailyStats(response.dailyStats);
        }

        // Load contacted leads from storage (non-blocking)
        if (response.contactedLeads && Array.isArray(response.contactedLeads)) {
          // Store contacted leads for display in success logs
          if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ 'indiamart_contacted_leads_cache': response.contactedLeads });
          }
        }

        // Determine app state immediately based on response
        if (response.agentStopped) {
          // Agent is stopped - update UI immediately, load data in background
          setAppState(AppState.Idle);
          setAgentInitialized(true);
          
          // Load persisted data from storage (non-blocking)
          if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.get(['indiamart_leads_cache', 'indiamart_filtered_leads_cache', 'indiamart_contacted_leads_cache'], (result) => {
              if (result.indiamart_leads_cache && Array.isArray(result.indiamart_leads_cache)) {
                setLeads(result.indiamart_leads_cache);
              }
              if (result.indiamart_filtered_leads_cache && Array.isArray(result.indiamart_filtered_leads_cache)) {
                setFilteredLeads(result.indiamart_filtered_leads_cache);
              }
              // Update stats from stored contacted leads
              if (result.indiamart_contacted_leads_cache && Array.isArray(result.indiamart_contacted_leads_cache)) {
                setAutoContactStats((prev) => ({
                  ...prev,
                  totalContacted: result.indiamart_contacted_leads_cache.length,
                  totalFiltered: result.indiamart_filtered_leads_cache?.length || prev.totalFiltered,
                }));
              }
              // Update app state if we have leads data
              if (result.indiamart_leads_cache && Array.isArray(result.indiamart_leads_cache) && result.indiamart_leads_cache.length > 0) {
                setAppState(AppState.LeadsScraped);
              }
            });
          }
          return;
        }

        if (response.agentActive && response.leadsPayload) {
          // Agent is active with leads payload - update everything immediately
          const allLeads = response.leadsPayload.allLeads || [];
          const filteredLeadsData = response.leadsPayload.filteredLeads || [];
          
          setLeads(allLeads);
          setFilteredLeads(filteredLeadsData);
          setAgentInitialized(true);
          
          // Update app state immediately based on auto-contact status
          setAppState(response.autoContactEnabled ? AppState.AutoContact : AppState.LeadsScraped);
          
          // Persist leads to storage (non-blocking)
          if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({
              'indiamart_leads_cache': allLeads,
              'indiamart_filtered_leads_cache': filteredLeadsData,
            });
          }
          
          if (response.leadsPayload?.filters) {
            setFilterCriteria(response.leadsPayload.filters);
          }
          setAutoContactStats((prev) => {
            const newFilteredLeads = response.leadsPayload?.filteredLeads;
            const filteredCount = Array.isArray(newFilteredLeads)
              ? newFilteredLeads.length
              : prev.totalFiltered;
            const contactedCount =
              typeof response.statistics?.totalContacted === 'number'
                ? response.statistics.totalContacted
                : prev.totalContacted;
            return {
              ...prev,
              totalFiltered: filteredCount,
              totalContacted: contactedCount,
            };
          });
        } else if (response.agentActive && !response.leadsPayload) {
          // Agent is active but no leads payload yet - show loading or auto-contact state
          setAgentInitialized(true);
          setAppState(response.autoContactEnabled ? AppState.AutoContact : AppState.Loading);
          
          // Try to load persisted data in background
          if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.get(['indiamart_leads_cache', 'indiamart_filtered_leads_cache', 'indiamart_contacted_leads_cache'], (result) => {
              if (result.indiamart_leads_cache && Array.isArray(result.indiamart_leads_cache)) {
                setLeads(result.indiamart_leads_cache);
                setAppState(response.autoContactEnabled ? AppState.AutoContact : AppState.LeadsScraped);
              }
              if (result.indiamart_filtered_leads_cache && Array.isArray(result.indiamart_filtered_leads_cache)) {
                setFilteredLeads(result.indiamart_filtered_leads_cache);
              }
              if (result.indiamart_contacted_leads_cache && Array.isArray(result.indiamart_contacted_leads_cache)) {
                setAutoContactStats((prev) => ({
                  ...prev,
                  totalContacted: result.indiamart_contacted_leads_cache.length,
                }));
              }
            });
          }
        } else {
          // Agent not active - try to load persisted data but update UI immediately
          const hasAutoContact = response.autoContactEnabled;
          setAgentInitialized(false);
          
          // Update app state immediately based on whether we might have cached data
          // We'll check storage but don't wait for it
          setAppState(hasAutoContact ? AppState.AutoContact : AppState.Idle);
          
          // Try to load persisted data if agent is not active (non-blocking)
          if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.get(['indiamart_leads_cache', 'indiamart_filtered_leads_cache', 'indiamart_contacted_leads_cache'], (result) => {
              if (result.indiamart_leads_cache && Array.isArray(result.indiamart_leads_cache)) {
                setLeads(result.indiamart_leads_cache);
                setAgentInitialized(true);
                setAppState(hasAutoContact ? AppState.AutoContact : AppState.LeadsScraped);
              }
              if (result.indiamart_filtered_leads_cache && Array.isArray(result.indiamart_filtered_leads_cache)) {
                setFilteredLeads(result.indiamart_filtered_leads_cache);
              }
              if (result.indiamart_contacted_leads_cache && Array.isArray(result.indiamart_contacted_leads_cache)) {
                setAutoContactStats((prev) => ({
                  ...prev,
                  totalContacted: result.indiamart_contacted_leads_cache.length,
                }));
              }
            });
          }
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
            // Always update auto-contact state from payload if provided, otherwise keep current state
            const autoContactFlag = typeof message.payload.autoContactEnabled === 'boolean' 
              ? message.payload.autoContactEnabled 
              : Boolean(message.payload.autoContactEnabled ?? autoContactEnabled);
            setAutoContactEnabled(autoContactFlag);
            setAppState(autoContactFlag ? AppState.AutoContact : AppState.LeadsScraped);
            setAgentInitialized(true);
            setAgentStopped(false);
            agentStoppedRef.current = false;
            setAutoContactStats(prev => {
              const newFilteredLeads = message.payload?.filteredLeads;
              const filteredCount = Array.isArray(newFilteredLeads)
                ? newFilteredLeads.length
                : prev.totalFiltered;
              return {
                ...prev,
                totalFiltered: filteredCount
              };
            });
            if (message.payload.filters) {
              setFilterCriteria(message.payload.filters);
            }
            if (message.payload.cycleSummary) {
              setCycleSummary(message.payload.cycleSummary);
              if (message.payload.cycleSummary.dailyStats) {
                setDailyStats(message.payload.cycleSummary.dailyStats);
              }
              if (message.payload.cycleSummary.backoffActive) {
                setBackoffNotice('Automation is cooling off briefly to mimic human behavior.');
                if (backoffTimerRef.current) {
                  window.clearTimeout(backoffTimerRef.current);
                }
                backoffTimerRef.current = window.setTimeout(() => {
                  setBackoffNotice(null);
                  backoffTimerRef.current = null;
                }, 5 * 60 * 1000);
              }
            }
          }
        } else if (message.type === 'FILTER_CRITERIA_UPDATE') {
          if (message.payload) {
            setFilterCriteria(message.payload);
          }
        } else if (message.type === 'AUTO_CONTACT_UPDATE') {
          if (!agentStoppedRef.current) {
            // Update stats when a lead is contacted
            setAutoContactStats(prev => {
              const totalContacted =
                typeof message.statistics?.totalContacted === 'number'
                  ? message.statistics.totalContacted
                  : prev.totalContacted + 1;
              const totalFiltered =
                typeof message.statistics?.totalFiltered === 'number'
                  ? message.statistics.totalFiltered
                  : prev.totalFiltered;
              return {
                ...prev,
                totalContacted,
                totalFiltered
              };
            });
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
        } else if (message.type === 'DAILY_CONTACT_STATS') {
          if (message.payload) {
            setDailyStats(message.payload);
          }
        } else if (message.type === 'DAILY_CONTACT_LIMIT_REACHED') {
          if (message.payload) {
            setDailyStats(message.payload);
          }
          setBackoffNotice('Daily quota reached. Automation will resume automatically after midnight.');
          if (backoffTimerRef.current) {
            window.clearTimeout(backoffTimerRef.current);
          }
          backoffTimerRef.current = window.setTimeout(() => {
            setBackoffNotice(null);
            backoffTimerRef.current = null;
          }, 60 * 60 * 1000);
        } else if (message.type === 'AUTOMATION_BACKOFF') {
          const resumeAt = message.payload?.resumeAt
            ? new Date(message.payload.resumeAt).toLocaleTimeString()
            : 'soon';
          setBackoffNotice(`Cooling off briefly. Expected to resume around ${resumeAt}.`);
          if (backoffTimerRef.current) {
            window.clearTimeout(backoffTimerRef.current);
          }
          backoffTimerRef.current = window.setTimeout(() => {
            setBackoffNotice(null);
            backoffTimerRef.current = null;
          }, 10 * 60 * 1000);
        }
      };

      chrome.runtime.onMessage.addListener(messageListener);

      return () => {
        // Check again in case the context is lost during cleanup
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
           chrome.runtime.onMessage.removeListener(messageListener);
        }
        if (backoffTimerRef.current) {
          window.clearTimeout(backoffTimerRef.current);
          backoffTimerRef.current = null;
        }
      };
    } else {
        // This handles cases where the popup is opened in a non-extension context (e.g., local development server)
        setError("This application must be run as a Chrome extension.");
        setAppState(AppState.Error);
    }
  }, []);

  // Handler functions are provided by hooks (useAgentState and useFilterConfig)

  useEffect(() => {
    agentStoppedRef.current = agentStopped;
  }, [agentStopped]);

  const renderContent = () => {
    switch (appState) {
      case AppState.Loading:
        return <LoadingSpinner />;
      case AppState.LeadsScraped:
      case AppState.AutoContact:
        return (
          <div>
            <div className="p-4 bg-slate-800/50 sticky top-0 backdrop-blur-sm z-10 border-b border-slate-700">
               <h2 className="text-lg font-bold text-white text-center">Found {leads.length} Leads</h2>
               
               <AgentControls
                 autoContactEnabled={autoContactEnabled}
                 agentStopped={agentStopped}
                 filteredLeadsCount={filteredLeads.length}
                 stats={autoContactStats}
                 dailyStats={dailyStats}
                 backoffNotice={backoffNotice}
                 onToggleAutoContact={handleToggleAutoContact}
                 onStopAgent={handleStopAgent}
                 onDismissBackoff={() => {
                   setBackoffNotice(null);
                   if (backoffTimerRef.current) {
                     window.clearTimeout(backoffTimerRef.current);
                     backoffTimerRef.current = null;
                   }
                 }}
               />
               
               <FilterDetails
                 filterCriteria={filterCriteria}
                 cycleSummary={cycleSummary}
                 showFilterDetails={showFilterDetails}
                 onToggle={() => setShowFilterDetails(!showFilterDetails)}
               />
               
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
            <LeadsList
              leads={sortedLeads}
              filteredLeads={filteredLeads}
              autoContactEnabled={autoContactEnabled}
            />
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
            onClick={() => setShowSettings((v) => !v)}
            className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded-md"
          >
            {showSettings ? 'Hide Settings' : 'Settings'}
          </button>
        </div>
      </header>
      <main>
        {showSettings && (
          <SettingsPanel
            keywords={keywords}
            categories={categories}
            newKeyword={newKeyword}
            newCategory={newCategory}
            quantityMin={quantityMin}
            quantityUnit={quantityUnit}
            orderValue={orderValue}
            settingsMessage={settingsMessage}
            onNewKeywordChange={setNewKeyword}
            onNewCategoryChange={setNewCategory}
            onQuantityMinChange={setQuantityMin}
            onQuantityUnitChange={setQuantityUnit}
            onOrderValueChange={setOrderValue}
            onAddKeyword={handleAddKeyword}
            onRemoveKeyword={handleRemoveKeyword}
            onAddCategory={handleAddCategory}
            onRemoveCategory={handleRemoveCategory}
            onUpdateQuantity={handleUpdateQuantity}
            onUpdateOrderValue={handleUpdateOrderValue}
            onExport={handleExportConfig}
            onImport={handleImportConfig}
            onClose={() => setShowSettings(false)}
          />
        )}
        {renderContent()}
      </main>
    </div>
  );
};

export default App;
