// Fix: Added a triple-slash directive to include TypeScript types for the Chrome extension API.
/// <reference types="chrome" />

import type { Lead } from './types';

// Store auto-contact state
let autoContactState = {
  enabled: false,
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
let logProcessingAlarmActive = false;
let lastSuccessfulLogTime = 0; // Track last successful log save
const DIAGNOSTICS_KEY = 'indiamart_diagnostics';
const MAX_LOG_LINES = 1000;
const DIAGNOSTICS_ENABLED = false; // default off for main logs cleanliness
let lastInactivityNotify = 0;
const BUY_LEAD_SUSPENSION_KEY = 'indiamart_buylead_suspension';
const RESUME_ALARM_NAME = 'resumeAutoContact';

type SuspensionState = {
  active: boolean;
  resumeAt?: number;
  restoreAutoContact?: boolean;
};

let suspensionState: SuspensionState = { active: false };

const setBadge = (text: string, title: string, color: string) => {
  try {
    chrome.action?.setBadgeText({ text });
    chrome.action?.setBadgeBackgroundColor?.({ color });
    chrome.action?.setTitle?.({ title });
  } catch {}
};

const notify = async (id: string, title: string, message: string) => {
  try {
    if (!chrome.notifications) return;
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'images/icon128.png',
      title,
      message,
      priority: 0,
      requireInteraction: false,
      silent: true
    });
  } catch {}
};

// Save inactivity log entry directly from background script
const saveInactivityLog = async (inactiveDurationSeconds: number): Promise<void> => {
  try {
    const timestamp = new Date().toISOString();
    const dateStr = new Date().toLocaleString();
    const minutes = Math.floor(inactiveDurationSeconds / 60);
    const seconds = inactiveDurationSeconds % 60;
    if (!DIAGNOSTICS_ENABLED) {
      return; // Do not write inactivity into main logs by default
    }

    // Get existing diagnostics
    const result = await chrome.storage.local.get(DIAGNOSTICS_KEY);
    const existingDiag: string = result[DIAGNOSTICS_KEY] || '';

    // Create inactivity log entry (diagnostics only)
    const logEntry = `\n[${timestamp}] [Background] ⚠️ Inactive: background running; waiting for page visibility. Gap ${minutes}m ${seconds}s.\n`;
    const combined = existingDiag + logEntry;
    
    // Maintain rolling history
    const logLines = combined.split('\n');
    const trimmed = logLines.slice(-MAX_LOG_LINES).join('\n');

    // Save to storage
    await chrome.storage.local.set({ [DIAGNOSTICS_KEY]: trimmed });
  } catch (error) {
    console.error('[Background] Error saving inactivity log:', error);
  }
};

// Setup Chrome Alarm for periodic log processing (heartbeat - keeps service worker alive)
const setupLogProcessingAlarm = () => {
  if (logProcessingAlarmActive) {
    return; // Already set up
  }

  // Initialize last successful log time
  lastSuccessfulLogTime = Date.now();

  // Create alarm that fires every 30 seconds (0.5 minutes) - acts as heartbeat
  // Note: Chrome may throttle to minimum 1 minute, but we try 30 seconds first
  chrome.alarms.create('processLeadsForLogs', {
    periodInMinutes: 0.5 // 30 seconds - acts as heartbeat
  });

  logProcessingAlarmActive = true;
  console.log('[Background] Heartbeat alarm set up - will trigger every 30 seconds (keeps service worker alive)');
};

// Clear the alarm when auto-contact is disabled
const clearLogProcessingAlarm = () => {
  if (logProcessingAlarmActive) {
    chrome.alarms.clear('processLeadsForLogs');
    logProcessingAlarmActive = false;
    console.log('[Background] Log processing alarm cleared');
  }
};

const calculateNextMidnight = (): number => {
  const now = new Date();
  const next = new Date(now);
  next.setDate(now.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next.getTime();
};

const scheduleResumeAlarm = (resumeAt: number) => {
  chrome.alarms.clear(RESUME_ALARM_NAME);
  chrome.alarms.create(RESUME_ALARM_NAME, { when: resumeAt });
  console.log(`[Background] Scheduled resume alarm for ${new Date(resumeAt).toLocaleString()}`);
};

const persistSuspensionState = async () => {
  try {
    await chrome.storage.local.set({ [BUY_LEAD_SUSPENSION_KEY]: suspensionState });
  } catch (error) {
    console.error('[Background] Failed to persist suspension state:', error);
  }
};

const clearSuspensionState = async () => {
  suspensionState = { active: false };
  try {
    await chrome.storage.local.remove(BUY_LEAD_SUSPENSION_KEY);
  } catch (error) {
    console.error('[Background] Failed to clear suspension state:', error);
  }
};

const suspendAutomationForZeroBalance = async () => {
  const resumeAt = calculateNextMidnight();
  const restoreAutoContact = autoContactState.enabled && !autoContactState.stopped;

  if (suspensionState.active) {
    suspensionState.resumeAt = resumeAt;
    suspensionState.restoreAutoContact = suspensionState.restoreAutoContact || restoreAutoContact;
    await persistSuspensionState();
    scheduleResumeAlarm(resumeAt);
    return;
  }

  suspensionState = {
    active: true,
    resumeAt,
    restoreAutoContact,
  };

  autoContactState.enabled = false;
  autoContactState.stopped = true;
  agentActive = false;
  latestLeadsPayload = null;
  clearLogProcessingAlarm();
  setBadge('PA', 'BuyLead balance 0 - paused', '#f97316');

  await persistSuspensionState();
  scheduleResumeAlarm(resumeAt);

  chrome.tabs.query({ url: '*://seller.indiamart.com/*' }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'STOP_AGENT' });
      }
    });
  });

  sendMessageSafe({ type: 'BUY_LEAD_BALANCE_SUSPENDED', resumeAt });
  notify('indiamart-buylead-suspended', 'IndiaMART Agent paused', 'BuyLead balance is zero. Automation will resume at midnight.');
  console.warn('[Background] Automation suspended due to zero BuyLead balance until midnight.');
};

const resumeAutomationFromSuspension = async () => {
  if (!suspensionState.active) {
    return;
  }

  const shouldRestore = Boolean(suspensionState.restoreAutoContact);
  await clearSuspensionState();
  chrome.alarms.clear(RESUME_ALARM_NAME);
  setBadge('', 'IndiaMART Agent', '#0ea5e9');

  if (shouldRestore) {
    autoContactState.enabled = true;
    autoContactState.stopped = false;
    autoContactState.statistics.sessionStartTime = Date.now();
    setupLogProcessingAlarm();

    chrome.tabs.query({ url: '*://seller.indiamart.com/*' }, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'ENABLE_AUTO_CONTACT' });
        }
      });
    });

    sendMessageSafe({ type: 'BUY_LEAD_BALANCE_RESUMED', restored: true });
    notify('indiamart-buylead-resumed', 'IndiaMART Agent resumed', 'Automation restarted after BuyLead balance suspension.');
    console.log('[Background] Automation resumed automatically after zero balance suspension.');
  } else {
    sendMessageSafe({ type: 'BUY_LEAD_BALANCE_RESUMED', restored: false });
    notify('indiamart-buylead-resumed', 'IndiaMART Agent ready', 'BuyLead balance suspension ended. Automation remains paused.');
  }
};

const initializeSuspensionState = async () => {
  try {
    const stored = (await chrome.storage.local.get(BUY_LEAD_SUSPENSION_KEY))[BUY_LEAD_SUSPENSION_KEY] as SuspensionState | undefined;
    if (!stored || !stored.active) {
      return;
    }

    suspensionState = stored;
    const resumeAt = stored.resumeAt || calculateNextMidnight();

    if (resumeAt <= Date.now()) {
      await resumeAutomationFromSuspension();
    } else {
      scheduleResumeAlarm(resumeAt);
      setBadge('PA', 'BuyLead balance 0 - paused', '#f97316');
      console.warn('[Background] Suspension state restored. Automation paused until resume alarm fires.');
    }
  } catch (error) {
    console.error('[Background] Failed to initialize suspension state:', error);
  }
};

// Listen for alarm events (Heartbeat - keeps service worker alive)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'processLeadsForLogs') {
    // Heartbeat alarm fires - keeps service worker alive
    if (autoContactState.enabled && !autoContactState.stopped) {
      chrome.tabs.query({ url: '*://seller.indiamart.com/*' }, (tabs) => {
        if (tabs.length === 0) {
          // No tabs found - log inactivity
          const timeSinceLastLog = Date.now() - lastSuccessfulLogTime;
          if (timeSinceLastLog > 30000) { // Only log if more than 30 seconds
            saveInactivityLog(Math.floor(timeSinceLastLog / 1000));
            if (Date.now() - lastInactivityNotify > 5 * 60 * 1000) {
              notify('indiamart-inactive', 'IndiaMART Agent: Inactive', 'Tab inactive. Waiting for visibility to resume processing.');
              setBadge('!', 'Inactive: waiting for tab focus', '#ef4444');
              lastInactivityNotify = Date.now();
            }
          }
          return;
        }

        let activeTabFound = false;
        tabs.forEach(tab => {
          if (!tab.id) return;

          if (tab.active) {
            activeTabFound = true;
          }

          chrome.tabs.sendMessage(tab.id, { type: 'PROCESS_LEADS_FOR_LOGS' }, () => {
            if (chrome.runtime.lastError) {
              // Tab might be inactive, throttled, or content script not ready
              const timeSinceLastLog = Date.now() - lastSuccessfulLogTime;
              if (timeSinceLastLog > 60000) { // Only log if more than 1 minute
                saveInactivityLog(Math.floor(timeSinceLastLog / 1000));
              }
              console.debug('[Background] Could not send PROCESS_LEADS_FOR_LOGS:', chrome.runtime.lastError.message);
            } else {
              // Successfully communicated - content will emit LOGS_UPDATED if something actually changed
              lastSuccessfulLogTime = Date.now();
            }
          });
        });

        // If no active tab found, check if we should log inactivity
        if (!activeTabFound) {
          const timeSinceLastLog = Date.now() - lastSuccessfulLogTime;
          if (timeSinceLastLog > 60000) { // Only log if more than 1 minute
            saveInactivityLog(Math.floor(timeSinceLastLog / 1000));
            if (Date.now() - lastInactivityNotify > 5 * 60 * 1000) {
              notify('indiamart-inactive', 'IndiaMART Agent: Inactive', 'No active tab found. Waiting for visibility.');
              setBadge('!', 'Inactive: no tab found', '#ef4444');
              lastInactivityNotify = Date.now();
            }
          }
        }
      });
    }
  } else if (alarm.name === RESUME_ALARM_NAME) {
    void resumeAutomationFromSuspension();
  }
});

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

void initializeSuspensionState();

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
    autoContactState.stopped = false;
    autoContactState.statistics.sessionStartTime = Date.now();
    
    // Setup alarm for periodic log processing
    setupLogProcessingAlarm();
    
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
    autoContactState.stopped = false;
    
    // Clear alarm when auto-contact is disabled
    clearLogProcessingAlarm();
    
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
  } else if (message.type === 'BUY_LEAD_BALANCE_ZERO') {
    suspendAutomationForZeroBalance()
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error('[Background] Failed to suspend automation:', error);
        sendResponse({ success: false, error: (error as Error)?.message });
      });
    return true;
  } else if (message.type === 'AUTO_CONTACT_SUCCESS') {
    // Update statistics
    autoContactState.processedLeads.add(message.leadId);
    autoContactState.lastContactTime = Date.now();
    autoContactState.statistics.totalContacted = message.contactedCount || autoContactState.statistics.totalContacted + 1;
    autoContactState.statistics.totalFiltered = message.totalFiltered || autoContactState.statistics.totalFiltered;
    const tabHidden = Boolean(message.tabHidden);
    
    // Notify popup if open
    sendMessageSafe({
      type: 'AUTO_CONTACT_UPDATE',
      leadId: message.leadId,
      companyName: message.companyName,
      timestamp: message.timestamp,
      statistics: autoContactState.statistics
    });
    
    if (tabHidden) {
      const notificationId = `indiamart-success-${message.leadId || Date.now()}`;
      const company = message.companyName ? `Contacted ${message.companyName}` : 'Reply sent successfully.';
      void notify(notificationId, 'IndiaMART Agent: Successful Contact', company);
    }
    return true;
  } else if (message.type === 'STOP_AGENT') {
    autoContactState.enabled = false;
    autoContactState.stopped = true;
    agentActive = false;
    latestLeadsPayload = null;
    
    // Clear alarm when agent is stopped
    clearLogProcessingAlarm();
    
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
  } else if (message.type === 'LOG_PROCESSING_SUCCESS') {
    // Content script processed, but we only notify UI on actual change (LOGS_UPDATED)
    lastSuccessfulLogTime = Date.now();
    return true;
  } else if (message.type === 'LOGS_UPDATED') {
    // A real change was saved; update badge and notify once per change
    lastSuccessfulLogTime = Date.now();
    setBadge('OK', `Last update: ${new Date().toLocaleTimeString()}`, '#16a34a');
    notify('indiamart-update', 'IndiaMART Agent: Logs updated', `Updated at ${new Date().toLocaleTimeString()}`);
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
