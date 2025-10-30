// Fix: Added a triple-slash directive to include TypeScript types for the Chrome extension API.
/// <reference types="chrome" />

import type { Lead } from './types';

// Store auto-contact state
let autoContactState = {
  enabled: true,
  stopped: false,
  processedLeads: new Set<string>(),
  lastContactTime: 0,
  statistics: {
    totalContacted: 0,
    totalFiltered: 0,
    sessionStartTime: Date.now()
  }
};

let agentActive = false;
let latestLeadsPayload: { allLeads: Lead[]; filteredLeads: Lead[]; autoContactEnabled?: boolean } | null = null;

const sendMessageSafe = (message: unknown) => {
  if (!chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
    return;
  }

  try {
    chrome.runtime.sendMessage(message, () => {
      const error = chrome.runtime.lastError;
      if (error && !error.message?.includes('Receiving end does not exist')) {
        console.warn('[Background] sendMessage error:', error.message);
      }
    });
  } catch (error) {
    if (error instanceof Error) {
      console.warn('[Background] sendMessage threw:', error.message);
    }
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_AGENT') {
    const targetUrl = 'https://seller.indiamart.com/bltxn/?pref=relevant';

    const sendStatus = () => {
      sendResponse({
        success: true,
        agentActive,
        agentStopped: autoContactState.stopped,
        autoContactEnabled: autoContactState.enabled,
        leadsPayload: latestLeadsPayload,
      });
    };

    if (agentActive && latestLeadsPayload) {
      sendStatus();
      return true;
    }

    // Find if the tab already exists
    chrome.tabs.query({ url: targetUrl }, (tabs) => {
      autoContactState.stopped = false;
      autoContactState.enabled = true;
      agentActive = false;
      latestLeadsPayload = null;
      if (tabs.length > 0 && tabs[0].id) {
        // If tab exists, focus it and inject the script
        chrome.tabs.update(tabs[0].id, { active: true }, (tab) => {
          if (tab && tab.id) {
             injectScript(tab.id);
          }
        });
      } else {
        // If tab doesn't exist, create it
        chrome.tabs.create({ url: targetUrl, active: true }, (tab) => {
            if (tab && tab.id) {
                const listener = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
                    if (tabId === tab.id && changeInfo.status === 'complete') {
                        // Remove listener to avoid multiple injections
                        chrome.tabs.onUpdated.removeListener(listener);
                        injectScript(tabId);
                    }
                };
                chrome.tabs.onUpdated.addListener(listener);
            }
        });
      }

      sendStatus();
    });
    return true; // Indicates that the response is sent asynchronously
  } else if (message.type === 'ENABLE_AUTO_CONTACT') {
    autoContactState.enabled = true;
    autoContactState.statistics.sessionStartTime = Date.now();
    
    // Forward to all active IndiaMART tabs
    chrome.tabs.query({ url: '*://seller.indiamart.com/*' }, (tabs) => {
      tabs.forEach(tab => {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'ENABLE_AUTO_CONTACT' });
        }
      });
    });
    
    sendResponse({ success: true, state: autoContactState });
    return true;
  } else if (message.type === 'DISABLE_AUTO_CONTACT') {
    autoContactState.enabled = false;
    
    // Forward to all active IndiaMART tabs
    chrome.tabs.query({ url: '*://seller.indiamart.com/*' }, (tabs) => {
      tabs.forEach(tab => {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'DISABLE_AUTO_CONTACT' });
        }
      });
    });
    
    sendResponse({ success: true, state: autoContactState });
    return true;
  } else if (message.type === 'GET_AUTO_CONTACT_STATE') {
    sendResponse(autoContactState);
    return true;
  } else if (message.type === 'AUTO_CONTACT_SUCCESS') {
    // Update statistics
    autoContactState.processedLeads.add(message.leadId);
    autoContactState.lastContactTime = Date.now();
    autoContactState.statistics.totalContacted = message.contactedCount || autoContactState.statistics.totalContacted + 1;
    autoContactState.statistics.totalFiltered = message.totalFiltered || autoContactState.statistics.totalFiltered;
    
    // Notify popup if open
    sendMessageSafe({
      type: 'AUTO_CONTACT_UPDATE',
      leadId: message.leadId,
      companyName: message.companyName,
      timestamp: message.timestamp,
      statistics: autoContactState.statistics
    });
    return true;
  } else if (message.type === 'STOP_AGENT') {
    autoContactState.enabled = false;
    autoContactState.stopped = true;
    agentActive = false;
    latestLeadsPayload = null;
    
    // Forward to all active IndiaMART tabs
    chrome.tabs.query({ url: '*://seller.indiamart.com/*' }, (tabs) => {
      tabs.forEach(tab => {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'STOP_AGENT' });
        }
      });
    });
    
    sendResponse({ success: true, state: autoContactState });
    return true;
  } else if (message.type === 'FILTERED_LEADS_DATA') {
    // Update filtered count
    if (message.payload && message.payload.filteredLeads) {
      autoContactState.statistics.totalFiltered = message.payload.filteredLeads.length;
    }
    latestLeadsPayload = message.payload || null;
    agentActive = true;
    if (typeof message.payload?.autoContactEnabled === 'boolean') {
      autoContactState.enabled = message.payload.autoContactEnabled;
    }
    // Forward to popup
    sendMessageSafe(message);
    return true;
  } else if (message.type === 'RESET_STATISTICS') {
    autoContactState.processedLeads.clear();
    autoContactState.statistics = {
      totalContacted: 0,
      totalFiltered: 0,
      sessionStartTime: Date.now()
    };
    agentActive = false;
    latestLeadsPayload = null;
    sendResponse({ success: true, state: autoContactState });
    return true;
  } else if (message.type === 'GET_AGENT_STATUS') {
    sendResponse({
      success: true,
      agentActive,
      agentStopped: autoContactState.stopped,
      autoContactEnabled: autoContactState.enabled,
      statistics: autoContactState.statistics,
      leadsPayload: latestLeadsPayload,
    });
    return true;
  }
});

function injectScript(tabId: number) {
    chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
    }).catch((error) => {
      // Ignore errors about already injected scripts
      if (!error.message?.includes('Cannot access a chrome')) {
        console.log('Content script injection handled:', error.message);
      }
      agentActive = false;
    }).then(() => {
      if (chrome.runtime.lastError) {
        console.error('Script injection failed: ', chrome.runtime.lastError.message);
        // Send an error message back to the popup
        sendMessageSafe({ type: 'SCRAPING_ERROR', error: `Failed to inject script: ${chrome.runtime.lastError.message}` });
        agentActive = false;
      } else {
        console.log('Content script injected successfully');
        agentActive = true;
        sendMessageSafe({ type: 'AGENT_READY' });
        
        // If auto-contact is enabled, notify the content script
        if (autoContactState.enabled) {
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { type: 'ENABLE_AUTO_CONTACT' });
          }, 1000);
        }
      }
    });
}
