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
let lastInactivityNotify = 0;
const BUY_LEAD_SUSPENSION_KEY = 'indiamart_buylead_suspension';
const RESUME_ALARM_NAME = 'resumeAutoContact';

type SuspensionState = {
  active: boolean;
  resumeAt?: number;
  restoreAutoContact?: boolean;
};

let suspensionState: SuspensionState = { active: false };
type DailyContactStats = {
  date: string;
  count: number;
  limit: number;
  dayOfWeek: number;
};

let dailyStatsCache: DailyContactStats | null = null;

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
};

const persistSuspensionState = async () => {
  try {
    await chrome.storage.local.set({ [BUY_LEAD_SUSPENSION_KEY]: suspensionState });
  } catch (error) {
    // Failed to persist suspension state
  }
};

const clearSuspensionState = async () => {
  suspensionState = { active: false };
  try {
    await chrome.storage.local.remove(BUY_LEAD_SUSPENSION_KEY);
  } catch (error) {
    // Failed to clear suspension state
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

    chrome.tabs.query({ url: '*://seller.indiamart.com/*' }, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'ENABLE_AUTO_CONTACT' });
        }
      });
    });

    sendMessageSafe({ type: 'BUY_LEAD_BALANCE_RESUMED', restored: true });
    notify('indiamart-buylead-resumed', 'IndiaMART Agent resumed', 'Automation restarted after BuyLead balance suspension.');
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
    }
  } catch (error) {
    // Failed to initialize suspension state
  }
};

// Listen for alarm events
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESUME_ALARM_NAME) {
    void resumeAutomationFromSuspension();
  }
});

const sendMessageSafe = (message: unknown) => {
  if (!chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
    return;
  }

  try {
    chrome.runtime.sendMessage(message, () => {
      // Message sent (ignore errors about no receiving end)
    });
  } catch (error) {
    // Failed to send message
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
        dailyStats: dailyStatsCache,
      });
    };

    if (agentActive && latestLeadsPayload) {
      sendStatus();
      return true;
    }

    // Find if the tab already exists
    chrome.tabs.query({ url: targetUrl }, (tabs) => {
      autoContactState.stopped = false;
      autoContactState.enabled = true; // Enable auto-contact by default when agent starts
      autoContactState.statistics.sessionStartTime = Date.now();
      agentActive = false;
      latestLeadsPayload = null;
      
      const enableAutoContact = (tabId: number) => {
        // Wait a bit for content script to be ready, then enable auto-contact
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { type: 'ENABLE_AUTO_CONTACT' }, (response) => {
            if (chrome.runtime.lastError) {
              // Content script might not be ready yet, try again
              setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { type: 'ENABLE_AUTO_CONTACT' });
              }, 1000);
            }
          });
        }, 500);
      };
      
      if (tabs.length > 0 && tabs[0].id) {
        // If tab exists, focus it and inject the script
        chrome.tabs.update(tabs[0].id, { active: true }, (tab) => {
          if (tab && tab.id) {
             injectScript(tab.id);
             enableAutoContact(tab.id);
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
                        enableAutoContact(tabId);
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
      dailyStats: dailyStatsCache,
    });
    return true;
  } else if (message.type === 'DAILY_CONTACT_STATS') {
    dailyStatsCache = message.payload ?? null;
    if (
      dailyStatsCache &&
      dailyStatsCache.count < dailyStatsCache.limit &&
      !suspensionState.active
    ) {
      setBadge('', 'IndiaMART Agent', '#0ea5e9');
    }
    sendMessageSafe({ type: 'DAILY_CONTACT_STATS', payload: dailyStatsCache });
    sendResponse?.({ success: true });
    return true;
  } else if (message.type === 'DAILY_CONTACT_LIMIT_REACHED') {
    dailyStatsCache = message.payload ?? dailyStatsCache;
    notify(
      'indiamart-daily-limit',
      'IndiaMART Agent: Daily quota met',
      'Automation will resume automatically tomorrow.'
    );
    sendMessageSafe({ type: 'DAILY_CONTACT_LIMIT_REACHED', payload: dailyStatsCache });
    setBadge('DQ', 'Daily quota reached', '#f97316');
    sendResponse?.({ success: true });
    return true;
  } else if (message.type === 'AUTOMATION_BACKOFF') {
    const resumeAt = message.payload?.resumeAt
      ? new Date(message.payload.resumeAt).toLocaleTimeString()
      : 'soon';
    notify('indiamart-backoff', 'IndiaMART Agent: Cooling off', `Resuming around ${resumeAt}.`);
    sendMessageSafe({ type: 'AUTOMATION_BACKOFF', payload: message.payload });
    setBadge('...', 'Temporarily pausing to mimic human behavior', '#facc15');
    sendResponse?.({ success: true });
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
        // Content script injection handled
      }
      agentActive = false;
    }).then(() => {
      if (chrome.runtime.lastError) {
        // Send an error message back to the popup
        sendMessageSafe({ type: 'SCRAPING_ERROR', error: `Failed to inject script: ${chrome.runtime.lastError.message}` });
        agentActive = false;
      } else {
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
