// Fix: Added a triple-slash directive to include TypeScript types for the Chrome extension API.
/// <reference types="chrome" />

import React, { useState, useEffect } from 'react';
import type { Lead } from './types';
import { LeadCard } from './components/LeadCard';
import { LogsPanel } from './components/LogsPanel';
import { SuccessPanel } from './components/SuccessPanel';

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

interface FilterCriteria {
  keywords?: string[];
  foreignIndicators?: string[];
  quantity?: { min?: number; unit?: string };
  orderValueMin?: number;
  categories?: string[];
}

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.Idle);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filteredLeads, setFilteredLeads] = useState<Lead[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'time' | 'company'>('time');
  const [autoContactEnabled, setAutoContactEnabled] = useState(false);
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
  const [showSuccess, setShowSuccess] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [filterCriteria, setFilterCriteria] = useState<FilterCriteria | null>(null);
  
  // Settings state
  const [keywords, setKeywords] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [quantityMin, setQuantityMin] = useState<string>('100');
  const [quantityUnit, setQuantityUnit] = useState<string>('piece');
  const [orderValue, setOrderValue] = useState<string>('50000');
  const [settingsMessage, setSettingsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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
          setAgentStopped(Boolean(response.agentStopped));
          agentStoppedRef.current = Boolean(response.agentStopped);
          setAgentInitialized(true);
          setAppState(response.autoContactEnabled ? AppState.AutoContact : AppState.LeadsScraped);
        } else {
          setAgentInitialized(false);
          setAutoContactEnabled(response?.autoContactEnabled ?? false);
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
            const autoContactFlag = Boolean(message.payload.autoContactEnabled ?? autoContactEnabled);
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
            setAutoContactEnabled(true);

            chrome.runtime.sendMessage({ type: 'ENABLE_AUTO_CONTACT' });

            if (response.leadsPayload) {
              setLeads(response.leadsPayload.allLeads || []);
              setFilteredLeads(response.leadsPayload.filteredLeads || []);
              setAgentInitialized(true);
              setAppState(AppState.AutoContact);
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

      chrome.runtime.sendMessage({ type: 'DISABLE_AUTO_CONTACT' }, () => {
        const disableError = chrome.runtime.lastError;
        if (disableError) {
          console.warn('DISABLE_AUTO_CONTACT error:', disableError.message);
        }
        chrome.runtime.sendMessage({ type: 'STOP_AGENT' }, () => {
          const stopError = chrome.runtime.lastError;
          if (stopError) {
            console.warn('STOP_AGENT error:', stopError.message);
          }
        });
      });
    }
  };

  // Load filter config from storage
  const loadFilterConfig = async () => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;

      try {
        const result = await chrome.storage.local.get([
          'indiamart_filter_keywords', 
          'indiamart_filter_categories',
          'indiamart_filter_quantity',
          'indiamart_filter_order_value'
        ]);
        
        if (Array.isArray(result.indiamart_filter_keywords) && result.indiamart_filter_keywords.length > 0) {
          setKeywords(result.indiamart_filter_keywords);
        } else {
          // Use defaults if not in storage
          setKeywords(filterCriteria?.keywords || []);
        }

        if (Array.isArray(result.indiamart_filter_categories) && result.indiamart_filter_categories.length > 0) {
          setCategories(result.indiamart_filter_categories);
        } else {
          // Use defaults if not in storage
          setCategories(filterCriteria?.categories || []);
        }

        // Load quantity threshold
        if (result.indiamart_filter_quantity && typeof result.indiamart_filter_quantity === 'object') {
          const qty = result.indiamart_filter_quantity;
          if (typeof qty.min === 'number') setQuantityMin(String(qty.min));
          if (typeof qty.unit === 'string') setQuantityUnit(qty.unit);
        } else if (filterCriteria?.quantity) {
          setQuantityMin(String(filterCriteria.quantity.min || 100));
          setQuantityUnit(filterCriteria.quantity.unit || 'piece');
        }

        // Load order value minimum
        if (typeof result.indiamart_filter_order_value === 'number') {
          setOrderValue(String(result.indiamart_filter_order_value));
        } else if (typeof filterCriteria?.orderValueMin === 'number') {
          setOrderValue(String(filterCriteria.orderValueMin));
        }
      } catch (error) {
        console.error('Error loading filter config:', error);
      }
  };

  // Save filter config to storage and notify content script
  const saveFilterConfig = async (
    newKeywords?: string[], 
    newCategories?: string[],
    newQuantity?: { min: number; unit: string },
    newOrderValue?: number
  ) => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return false;

    try {
      const toSave: Record<string, any> = {};

      if (newKeywords !== undefined) {
        const validated = newKeywords
          .filter(k => k.trim().length > 0 && k.trim().length <= 100)
          .map(k => k.trim())
          .slice(0, 500);
        toSave['indiamart_filter_keywords'] = validated;
        setKeywords(validated);
      }

      if (newCategories !== undefined) {
        const validated = newCategories
          .filter(c => c.trim().length > 0 && c.trim().length <= 100)
          .map(c => c.trim())
          .slice(0, 500);
        toSave['indiamart_filter_categories'] = validated;
        setCategories(validated);
      }

        // Save quantity threshold
        if (newQuantity !== undefined) {
          const validated = {
            min: Math.max(1, Math.min(newQuantity.min, 1000000)),
            unit: (newQuantity.unit || 'piece').trim().toLowerCase()
          };
          toSave['indiamart_filter_quantity'] = validated;
          setQuantityMin(String(validated.min));
          setQuantityUnit(validated.unit);
        }

        // Save order value minimum
        if (newOrderValue !== undefined) {
          const validated = Math.max(0, Math.min(newOrderValue, 100000000));
          toSave['indiamart_filter_order_value'] = validated;
          setOrderValue(String(validated));
        }

      if (Object.keys(toSave).length > 0) {
        await chrome.storage.local.set(toSave);
        console.log('[Popup] Filter config saved to storage:', toSave);
        
        // Small delay to ensure storage is committed before notifying content script
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Notify content script to reload
        chrome.tabs.query({ url: '*://seller.indiamart.com/*' }, (tabs) => {
          if (tabs.length === 0) {
            console.warn('[Popup] No IndiaMART tabs found to notify');
            return;
          }
          
          tabs.forEach(tab => {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, { type: 'FILTER_KEYWORDS_UPDATED' }, (response) => {
                if (chrome.runtime.lastError) {
                  console.warn('[Popup] Failed to notify tab', tab.id, ':', chrome.runtime.lastError.message);
                } else {
                  console.log('[Popup] Successfully notified tab', tab.id, 'about filter update');
                }
              });
            }
          });
        });

        setSettingsMessage({ type: 'success', text: 'Filter settings saved successfully!' });
        setTimeout(() => setSettingsMessage(null), 3000);
        return true;
      }

      return false;
    } catch (error) {
      console.error('Error saving filter config:', error);
      setSettingsMessage({ type: 'error', text: 'Failed to save filter settings.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      return false;
    }
  };

  // Add keyword
  const handleAddKeyword = () => {
    if (!newKeyword.trim() || newKeyword.trim().length > 100) {
      setSettingsMessage({ type: 'error', text: 'Keyword must be between 1-100 characters.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      return;
    }

    const trimmed = newKeyword.trim().toLowerCase();
    if (keywords.includes(trimmed)) {
      setSettingsMessage({ type: 'error', text: 'Keyword already exists.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      return;
    }

    const updated = [...keywords, trimmed];
    saveFilterConfig(updated, undefined);
    setNewKeyword('');
  };

  // Remove keyword
  const handleRemoveKeyword = (keyword: string) => {
    const updated = keywords.filter(k => k !== keyword);
    saveFilterConfig(updated, undefined);
  };

  // Add category
  const handleAddCategory = () => {
    if (!newCategory.trim() || newCategory.trim().length > 100) {
      setSettingsMessage({ type: 'error', text: 'Category must be between 1-100 characters.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      return;
    }

    const trimmed = newCategory.trim().toLowerCase();
    if (categories.includes(trimmed)) {
      setSettingsMessage({ type: 'error', text: 'Category already exists.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      return;
    }

    const updated = [...categories, trimmed];
    saveFilterConfig(undefined, updated);
    setNewCategory('');
  };

  // Remove category
  const handleRemoveCategory = (category: string) => {
    const updated = categories.filter(c => c !== category);
    saveFilterConfig(undefined, updated);
  };

  // Update quantity
  const handleUpdateQuantity = async () => {
    const numValue = parseInt(quantityMin.trim(), 10);
    if (isNaN(numValue) || numValue < 1 || numValue > 1000000) {
      setSettingsMessage({ type: 'error', text: 'Quantity must be between 1 and 1,000,000.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      // Reset to last valid value
      setQuantityMin('100');
      return;
    }
    const unitTrimmed = quantityUnit.trim().toLowerCase() || 'piece';
    try {
      const success = await saveFilterConfig(undefined, undefined, { min: numValue, unit: unitTrimmed }, undefined);
      if (!success) {
        setSettingsMessage({ type: 'error', text: 'Failed to save quantity threshold.' });
        setTimeout(() => setSettingsMessage(null), 3000);
      }
    } catch (error) {
      console.error('Error updating quantity:', error);
      setSettingsMessage({ type: 'error', text: 'Error saving quantity threshold.' });
      setTimeout(() => setSettingsMessage(null), 3000);
    }
  };

  // Update order value
  const handleUpdateOrderValue = async () => {
    const numValue = parseInt(orderValue.trim(), 10);
    if (isNaN(numValue) || numValue < 0 || numValue > 100000000) {
      setSettingsMessage({ type: 'error', text: 'Order value must be between ₹0 and ₹100,000,000.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      // Reset to last valid value
      setOrderValue('50000');
      return;
    }
    try {
      const success = await saveFilterConfig(undefined, undefined, undefined, numValue);
      if (!success) {
        setSettingsMessage({ type: 'error', text: 'Failed to save order value threshold.' });
        setTimeout(() => setSettingsMessage(null), 3000);
      }
    } catch (error) {
      console.error('Error updating order value:', error);
      setSettingsMessage({ type: 'error', text: 'Error saving order value threshold.' });
      setTimeout(() => setSettingsMessage(null), 3000);
    }
  };

  // Export filter config as JSON
  const handleExportConfig = () => {
    const config = {
      keywords: keywords,
      categories: categories,
      quantity: { min: parseInt(quantityMin) || 100, unit: quantityUnit },
      orderValue: parseInt(orderValue) || 50000,
      version: '1.0',
      updated: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `indiamart-filter-config-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setSettingsMessage({ type: 'success', text: 'Configuration exported successfully!' });
    setTimeout(() => setSettingsMessage(null), 3000);
  };

  // Import filter config from JSON file
  const handleImportConfig = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const config = JSON.parse(text);

      if (typeof config !== 'object' || config === null) {
        throw new Error('Invalid file format');
      }

      const importedKeywords: string[] = Array.isArray(config.keywords)
        ? config.keywords.filter((k: any) => typeof k === 'string' && k.trim().length > 0 && k.trim().length <= 100).slice(0, 500)
        : [];
      
      const importedCategories: string[] = Array.isArray(config.categories)
        ? config.categories.filter((c: any) => typeof c === 'string' && c.trim().length > 0 && c.trim().length <= 100).slice(0, 500)
        : [];

      const importedQuantity: { min: number; unit: string } | undefined = 
        config.quantity && typeof config.quantity === 'object' && typeof config.quantity.min === 'number' && typeof config.quantity.unit === 'string'
          ? { 
              min: Math.max(1, Math.min(config.quantity.min, 1000000)), 
              unit: config.quantity.unit.trim().toLowerCase() || 'piece' 
            }
          : undefined;

      const importedOrderValue: number | undefined = 
        typeof config.orderValue === 'number' && config.orderValue >= 0 && config.orderValue <= 100000000
          ? Math.max(0, Math.min(config.orderValue, 100000000))
          : undefined;

      if (importedKeywords.length === 0 && importedCategories.length === 0 && importedQuantity === undefined && importedOrderValue === undefined) {
        setSettingsMessage({ type: 'error', text: 'No valid keywords, categories, quantity, or order value found in file.' });
        setTimeout(() => setSettingsMessage(null), 3000);
        return;
      }

      await saveFilterConfig(
        importedKeywords.length > 0 ? importedKeywords : keywords,
        importedCategories.length > 0 ? importedCategories : categories,
        importedQuantity,
        importedOrderValue
      );

      setSettingsMessage({ type: 'success', text: 'Configuration imported successfully!' });
      setTimeout(() => setSettingsMessage(null), 3000);
    } catch (error) {
      console.error('Error importing config:', error);
      setSettingsMessage({ type: 'error', text: 'Failed to import configuration. Please check file format.' });
      setTimeout(() => setSettingsMessage(null), 3000);
    }

    // Reset file input
    event.target.value = '';
  };

  // Load config when settings panel opens
  useEffect(() => {
    if (showSettings) {
      loadFilterConfig();
    }
  }, [showSettings, filterCriteria]);

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
                  {filterCriteria ? (
                    <>
                      {filterCriteria.keywords && filterCriteria.keywords.length > 0 && (
                        <div>
                          ✓ Keywords: {filterCriteria.keywords.slice(0, 6).join(', ')}
                          {filterCriteria.keywords.length > 6 ? ', …' : ''}
                        </div>
                      )}
                      {filterCriteria.foreignIndicators && filterCriteria.foreignIndicators.length > 0 && (
                        <div>
                          ✓ Location: Rejects foreign leads ({filterCriteria.foreignIndicators.map((item) =>
                            item.toUpperCase()
                          ).join(', ')})
                        </div>
                      )}
                      {filterCriteria.quantity && typeof filterCriteria.quantity.min === 'number' && (
                        <div>
                          ✓ Quantity: ≥ {filterCriteria.quantity.min}{' '}
                          {filterCriteria.quantity.unit ? `${filterCriteria.quantity.unit}s` : ''}
                        </div>
                      )}
                      {typeof filterCriteria.orderValueMin === 'number' && (
                        <div>✓ Order Value: ≥ ₹{filterCriteria.orderValueMin.toLocaleString()}</div>
                      )}
                      {filterCriteria.categories && filterCriteria.categories.length > 0 && (
                        <div>✓ Categories: {filterCriteria.categories.join(', ')}</div>
                      )}
                      {!filterCriteria.keywords &&
                        !filterCriteria.foreignIndicators &&
                        !filterCriteria.quantity &&
                        typeof filterCriteria.orderValueMin !== 'number' &&
                        !filterCriteria.categories && (
                          <div className="italic text-slate-500">No active filters.</div>
                        )}
                    </>
                  ) : (
                    <div className="italic text-slate-500">No filter information received yet.</div>
                  )}
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
          <button
            onClick={() => setShowSuccess((v) => !v)}
            className="px-3 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-white rounded-md"
          >
            {showSuccess ? 'Hide Success' : 'Show Success'}
          </button>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded-md"
          >
            {showSettings ? 'Hide Settings' : 'Settings'}
          </button>
        </div>
      </header>
      <main>
        {showLogs && (
          <div className="border-b border-slate-800">
            <LogsPanel onClose={() => setShowLogs(false)} />
          </div>
        )}
        {showSuccess && (
          <SuccessPanel onClose={() => setShowSuccess(false)} />
        )}
        {showSettings && (
          <div className="border-b border-slate-800 p-4 bg-slate-900 max-h-[500px] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-slate-200">Filter Settings</h2>
              <button
                onClick={() => setShowSettings(false)}
                className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-white rounded"
              >
                ✕
              </button>
            </div>

            {settingsMessage && (
              <div className={`mb-4 p-2 rounded text-xs ${
                settingsMessage.type === 'success' 
                  ? 'bg-green-900/30 text-green-400' 
                  : 'bg-red-900/30 text-red-400'
              }`}>
                {settingsMessage.text}
              </div>
            )}

            {/* Keywords Section */}
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-2">Keywords</h3>
              <div className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleAddKeyword()}
                  placeholder="Add keyword (e.g., DAV School Blazers)"
                  className="flex-1 bg-slate-800 border border-slate-700 text-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  maxLength={100}
                />
                <button
                  onClick={handleAddKeyword}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm"
                >
                  Add
                </button>
              </div>
              <div className="max-h-32 overflow-y-auto bg-slate-800 rounded p-2 space-y-1">
                {keywords.length === 0 ? (
                  <p className="text-xs text-slate-500">No keywords. Add one above.</p>
                ) : (
                  keywords.map((keyword, idx) => (
                    <div key={idx} className="flex items-center justify-between bg-slate-700/50 rounded px-2 py-1 text-xs">
                      <span className="text-slate-300">{keyword}</span>
                      <button
                        onClick={() => handleRemoveKeyword(keyword)}
                        className="text-red-400 hover:text-red-300 ml-2"
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Categories Section */}
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-2">Categories</h3>
              <div className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleAddCategory()}
                  placeholder="Add category"
                  className="flex-1 bg-slate-800 border border-slate-700 text-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  maxLength={100}
                />
                <button
                  onClick={handleAddCategory}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm"
                >
                  Add
                </button>
              </div>
              <div className="max-h-32 overflow-y-auto bg-slate-800 rounded p-2 space-y-1">
                {categories.length === 0 ? (
                  <p className="text-xs text-slate-500">No categories. Add one above.</p>
                ) : (
                  categories.map((category, idx) => (
                    <div key={idx} className="flex items-center justify-between bg-slate-700/50 rounded px-2 py-1 text-xs">
                      <span className="text-slate-300">{category}</span>
                      <button
                        onClick={() => handleRemoveCategory(category)}
                        className="text-red-400 hover:text-red-300 ml-2"
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Quantity Threshold Section */}
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-2">Quantity Threshold</h3>
              <div className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={quantityMin}
                  onChange={(e) => {
                    const value = e.target.value;
                    // Allow empty or numeric values only
                    if (value === '' || /^\d+$/.test(value)) {
                      setQuantityMin(value);
                    }
                  }}
                  onKeyPress={(e) => e.key === 'Enter' && handleUpdateQuantity()}
                  onBlur={handleUpdateQuantity}
                  placeholder="Minimum quantity"
                  className="flex-1 bg-slate-800 border border-slate-700 text-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <input
                  type="text"
                  value={quantityUnit}
                  onChange={(e) => setQuantityUnit(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleUpdateQuantity()}
                  placeholder="Unit (e.g., piece)"
                  className="w-28 bg-slate-800 border border-slate-700 text-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  onClick={handleUpdateQuantity}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm"
                >
                  Update
                </button>
              </div>
              <p className="text-xs text-slate-500">Current: ≥ {parseInt(quantityMin) || 0} {quantityUnit}</p>
            </div>

            {/* Order Value Threshold Section */}
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-slate-300 mb-2">Order Value Threshold</h3>
              <div className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={orderValue}
                  onChange={(e) => {
                    const value = e.target.value;
                    // Allow empty or numeric values only
                    if (value === '' || /^\d+$/.test(value)) {
                      setOrderValue(value);
                    }
                  }}
                  onKeyPress={(e) => e.key === 'Enter' && handleUpdateOrderValue()}
                  onBlur={handleUpdateOrderValue}
                  placeholder="Minimum order value (₹)"
                  className="flex-1 bg-slate-800 border border-slate-700 text-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  onClick={handleUpdateOrderValue}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm"
                >
                  Update
                </button>
              </div>
              <p className="text-xs text-slate-500">Current: ≥ ₹{(parseInt(orderValue) || 0).toLocaleString()}</p>
            </div>

            {/* Import/Export Section */}
            <div className="flex gap-2">
              <label className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm text-center cursor-pointer">
                Import JSON
                <input
                  type="file"
                  accept=".json"
                  onChange={handleImportConfig}
                  className="hidden"
                />
              </label>
              <button
                onClick={handleExportConfig}
                className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm"
              >
                Export JSON
              </button>
            </div>
          </div>
        )}
        {renderContent()}
      </main>
    </div>
  );
};

export default App;
