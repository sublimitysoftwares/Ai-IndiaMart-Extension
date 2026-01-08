// Background script message handlers

import type { Lead } from '../types';
import {
  autoContactState,
  getAgentActive,
  setAgentActive,
  getLatestLeadsPayload,
  setLatestLeadsPayload,
  getSuspensionState,
  setSuspensionState,
  getDailyStatsCache,
  setDailyStatsCache,
  persistSuspensionState,
  clearSuspensionState,
} from './stateManager';
import { MESSAGE_TYPES } from '../constants/messages';
import { TARGET_URL } from '../constants';
import { sendMessageSafe, sendMessageToTab } from '../services/chrome/messaging';
import {
  queryIndiaMARTTabs,
  queryTargetTab,
  updateTab,
  createTab,
  addTabUpdateListener,
  removeTabUpdateListener,
} from '../services/chrome/tabs';
import { executeScript } from '../services/chrome/scripting';
import { setBadge } from '../services/chrome/badge';
import { createNotification } from '../services/chrome/notifications';
import { scheduleResumeAlarm, clearAlarm } from '../services/chrome/alarms';
import { calculateNextMidnight } from '../utils/time';
import { RESUME_ALARM_NAME } from '../constants/timing';

export const handleStartAgent = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean => {
  const sendStatus = () => {
    sendResponse({
      success: true,
      agentActive: getAgentActive(),
      agentStopped: autoContactState.stopped,
      autoContactEnabled: autoContactState.enabled,
      leadsPayload: getLatestLeadsPayload(),
      dailyStats: getDailyStatsCache(),
    });
  };

  if (getAgentActive() && getLatestLeadsPayload()) {
    sendStatus();
    return true;
  }

  queryTargetTab().then((tabs) => {
    autoContactState.stopped = false;
    autoContactState.enabled = true;
    autoContactState.statistics.sessionStartTime = Date.now();
    setAgentActive(false);
    setLatestLeadsPayload(null);

    const enableAutoContact = (tabId: number) => {
      setTimeout(() => {
        sendMessageToTab(tabId, { type: MESSAGE_TYPES.ENABLE_AUTO_CONTACT }, () => {
          if (chrome.runtime.lastError) {
            setTimeout(() => {
              sendMessageToTab(tabId, { type: MESSAGE_TYPES.ENABLE_AUTO_CONTACT });
            }, 1000);
          }
        });
      }, 500);
    };

    if (tabs.length > 0 && tabs[0].id) {
      updateTab(tabs[0].id, { active: true }).then((tab) => {
        if (tab && tab.id) {
          injectScript(tab.id);
          enableAutoContact(tab.id);
        }
      });
    } else {
      createTab({ url: TARGET_URL, active: true }).then((tab) => {
        if (tab && tab.id) {
          const listener = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
            if (tabId === tab.id && changeInfo.status === 'complete') {
              removeTabUpdateListener(listener);
              injectScript(tabId);
              enableAutoContact(tabId);
            }
          };
          addTabUpdateListener(listener);
        }
      });
    }

    sendStatus();
  });

  return true;
};

export const handleEnableAutoContact = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean => {
  autoContactState.enabled = true;
  autoContactState.stopped = false;
  autoContactState.statistics.sessionStartTime = Date.now();

  queryIndiaMARTTabs().then((tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) {
        sendMessageToTab(tab.id, { type: MESSAGE_TYPES.ENABLE_AUTO_CONTACT });
      }
    });
  });

  sendResponse({ success: true, state: autoContactState });
  return true;
};

export const handleDisableAutoContact = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean => {
  autoContactState.enabled = false;
  autoContactState.stopped = false;

  queryIndiaMARTTabs().then((tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) {
        sendMessageToTab(tab.id, { type: MESSAGE_TYPES.DISABLE_AUTO_CONTACT });
      }
    });
  });

  sendResponse({ success: true, state: autoContactState });
  return true;
};

export const handleStopAgent = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean => {
  autoContactState.enabled = false;
  autoContactState.stopped = true;
  setAgentActive(false);
  setLatestLeadsPayload(null);

  queryIndiaMARTTabs().then((tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) {
        sendMessageToTab(tab.id, { type: MESSAGE_TYPES.STOP_AGENT });
      }
    });
  });

  sendResponse({ success: true, state: autoContactState });
  return true;
};

export const handleAutoContactSuccess = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean => {
  autoContactState.processedLeads.add(message.leadId);
  autoContactState.lastContactTime = Date.now();
  autoContactState.statistics.totalContacted =
    message.contactedCount || autoContactState.statistics.totalContacted + 1;
  autoContactState.statistics.totalFiltered =
    message.totalFiltered || autoContactState.statistics.totalFiltered;
  const tabHidden = Boolean(message.tabHidden);

  sendMessageSafe({
    type: MESSAGE_TYPES.AUTO_CONTACT_UPDATE,
    leadId: message.leadId,
    companyName: message.companyName,
    timestamp: message.timestamp,
    statistics: autoContactState.statistics,
  });

  if (tabHidden) {
    const notificationId = `indiamart-success-${message.leadId || Date.now()}`;
    const company = message.companyName ? `Contacted ${message.companyName}` : 'Reply sent successfully.';
    void createNotification(notificationId, 'IndiaMART Agent: Successful Contact', company);
  }
  return true;
};

export const handleFilteredLeadsData = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean => {
  if (message.payload && message.payload.filteredLeads) {
    autoContactState.statistics.totalFiltered = message.payload.filteredLeads.length;
  }
  setLatestLeadsPayload(message.payload || null);
  setAgentActive(true);
  if (typeof message.payload?.autoContactEnabled === 'boolean') {
    autoContactState.enabled = message.payload.autoContactEnabled;
  }
  sendMessageSafe(message);
  return true;
};

export const handleResetStatistics = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean => {
  autoContactState.processedLeads.clear();
  autoContactState.statistics = {
    totalContacted: 0,
    totalFiltered: 0,
    sessionStartTime: Date.now(),
  };
  setAgentActive(false);
  setLatestLeadsPayload(null);
  sendResponse({ success: true, state: autoContactState });
  return true;
};

export const handleGetAgentStatus = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean => {
  sendResponse({
    success: true,
    agentActive: getAgentActive(),
    agentStopped: autoContactState.stopped,
    autoContactEnabled: autoContactState.enabled,
    statistics: autoContactState.statistics,
    leadsPayload: getLatestLeadsPayload(),
    dailyStats: getDailyStatsCache(),
  });
  return true;
};

export const handleDailyContactStats = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean => {
  const stats = message.payload ?? null;
  setDailyStatsCache(stats);
  if (stats && stats.count < stats.limit && !getSuspensionState().active) {
    setBadge('', 'IndiaMART Agent', '#0ea5e9');
  }
  sendMessageSafe({ type: MESSAGE_TYPES.DAILY_CONTACT_STATS, payload: stats });
  sendResponse?.({ success: true });
  return true;
};

export const handleDailyContactLimitReached = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean => {
  const stats = message.payload ?? getDailyStatsCache();
  setDailyStatsCache(stats);
  void createNotification(
    'indiamart-daily-limit',
    'IndiaMART Agent: Daily quota met',
    'Automation will resume automatically tomorrow.'
  );
  sendMessageSafe({ type: MESSAGE_TYPES.DAILY_CONTACT_LIMIT_REACHED, payload: stats });
  setBadge('DQ', 'Daily quota reached', '#f97316');
  sendResponse?.({ success: true });
  return true;
};

export const handleAutomationBackoff = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean => {
  const resumeAt = message.payload?.resumeAt
    ? new Date(message.payload.resumeAt).toLocaleTimeString()
    : 'soon';
  void createNotification('indiamart-backoff', 'IndiaMART Agent: Cooling off', `Resuming around ${resumeAt}.`);
  sendMessageSafe({ type: MESSAGE_TYPES.AUTOMATION_BACKOFF, payload: message.payload });
  setBadge('...', 'Temporarily pausing to mimic human behavior', '#facc15');
  sendResponse?.({ success: true });
  return true;
};

export const handleBuyLeadBalanceZero = async (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): Promise<boolean> => {
  const resumeAt = calculateNextMidnight();
  const restoreAutoContact = autoContactState.enabled && !autoContactState.stopped;
  const currentState = getSuspensionState();

  if (currentState.active) {
    setSuspensionState({
      ...currentState,
      resumeAt,
      restoreAutoContact: currentState.restoreAutoContact || restoreAutoContact,
    });
    await persistSuspensionState();
    scheduleResumeAlarm(resumeAt);
    sendResponse({ success: true });
    return true;
  }

  setSuspensionState({
    active: true,
    resumeAt,
    restoreAutoContact,
  });

  autoContactState.enabled = false;
  autoContactState.stopped = true;
  setAgentActive(false);
  setLatestLeadsPayload(null);
  setBadge('PA', 'BuyLead balance 0 - paused', '#f97316');

  await persistSuspensionState();
  scheduleResumeAlarm(resumeAt);

  queryIndiaMARTTabs().then((tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) {
        sendMessageToTab(tab.id, { type: MESSAGE_TYPES.STOP_AGENT });
      }
    });
  });

  sendMessageSafe({ type: MESSAGE_TYPES.BUY_LEAD_BALANCE_SUSPENDED, resumeAt });
  void createNotification(
    'indiamart-buylead-suspended',
    'IndiaMART Agent paused',
    'BuyLead balance is zero. Automation will resume at midnight.'
  );

  sendResponse({ success: true });
  return true;
};

export const resumeAutomationFromSuspension = async (): Promise<void> => {
  const currentState = getSuspensionState();
  if (!currentState.active) {
    return;
  }

  const shouldRestore = Boolean(currentState.restoreAutoContact);
  await clearSuspensionState();
  clearAlarm(RESUME_ALARM_NAME);
  setBadge('', 'IndiaMART Agent', '#0ea5e9');

  if (shouldRestore) {
    autoContactState.enabled = true;
    autoContactState.stopped = false;
    autoContactState.statistics.sessionStartTime = Date.now();

    queryIndiaMARTTabs().then((tabs) => {
      tabs.forEach((tab) => {
        if (tab.id) {
          sendMessageToTab(tab.id, { type: MESSAGE_TYPES.ENABLE_AUTO_CONTACT });
        }
      });
    });

    sendMessageSafe({ type: MESSAGE_TYPES.BUY_LEAD_BALANCE_RESUMED, restored: true });
    void createNotification(
      'indiamart-buylead-resumed',
      'IndiaMART Agent resumed',
      'Automation restarted after BuyLead balance suspension.'
    );
  } else {
    sendMessageSafe({ type: MESSAGE_TYPES.BUY_LEAD_BALANCE_RESUMED, restored: false });
    void createNotification(
      'indiamart-buylead-resumed',
      'IndiaMART Agent ready',
      'BuyLead balance suspension ended. Automation remains paused.'
    );
  }
};

const injectScript = async (tabId: number): Promise<void> => {
  try {
    await executeScript(tabId, ['content.js']);
    setAgentActive(true);
    sendMessageSafe({ type: MESSAGE_TYPES.AGENT_READY });

    if (autoContactState.enabled) {
      setTimeout(() => {
        sendMessageToTab(tabId, { type: MESSAGE_TYPES.ENABLE_AUTO_CONTACT });
      }, 1000);
    }
  } catch (error) {
    if (!(error as Error).message?.includes('Cannot access a chrome')) {
      // Content script injection handled
    }
    setAgentActive(false);
    sendMessageSafe({
      type: MESSAGE_TYPES.SCRAPING_ERROR,
      error: `Failed to inject script: ${(error as Error).message}`,
    });
  }
};

// Export message router
export const handleMessage = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean | undefined => {
  switch (message.type) {
    case MESSAGE_TYPES.START_AGENT:
      return handleStartAgent(message, sender, sendResponse);
    case MESSAGE_TYPES.ENABLE_AUTO_CONTACT:
      return handleEnableAutoContact(message, sender, sendResponse);
    case MESSAGE_TYPES.DISABLE_AUTO_CONTACT:
      return handleDisableAutoContact(message, sender, sendResponse);
    case MESSAGE_TYPES.GET_AUTO_CONTACT_STATE:
      sendResponse(autoContactState);
      return true;
    case MESSAGE_TYPES.BUY_LEAD_BALANCE_ZERO:
      handleBuyLeadBalanceZero(message, sender, sendResponse).catch((error) => {
        sendResponse({ success: false, error: (error as Error)?.message });
      });
      return true;
    case MESSAGE_TYPES.AUTO_CONTACT_SUCCESS:
      return handleAutoContactSuccess(message, sender, sendResponse);
    case MESSAGE_TYPES.STOP_AGENT:
      return handleStopAgent(message, sender, sendResponse);
    case MESSAGE_TYPES.FILTERED_LEADS_DATA:
      return handleFilteredLeadsData(message, sender, sendResponse);
    case MESSAGE_TYPES.RESET_STATISTICS:
      return handleResetStatistics(message, sender, sendResponse);
    case MESSAGE_TYPES.GET_AGENT_STATUS:
      return handleGetAgentStatus(message, sender, sendResponse);
    case MESSAGE_TYPES.DAILY_CONTACT_STATS:
      return handleDailyContactStats(message, sender, sendResponse);
    case MESSAGE_TYPES.DAILY_CONTACT_LIMIT_REACHED:
      return handleDailyContactLimitReached(message, sender, sendResponse);
    case MESSAGE_TYPES.AUTOMATION_BACKOFF:
      return handleAutomationBackoff(message, sender, sendResponse);
    default:
      return undefined;
  }
};