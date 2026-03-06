// Background script entry point - thin orchestrator

/// <reference types="chrome" />

import { handleMessage } from './messageHandlers';
import { initializeSuspensionState, getSuspensionState, initializeAutoContactState, autoContactState } from './stateManager';
import { scheduleResumeAlarm, addAlarmListener, createAlarm } from '../services/chrome/alarms';
import { RESUME_ALARM_NAME } from '../constants/timing';
import { setBadge } from '../services/chrome/badge';
import { resumeAutomationFromSuspension } from './messageHandlers';
import { queryIndiaMARTTabs } from '../services/chrome/tabs';
import { sendMessageToTab } from '../services/chrome/messaging';
import { MESSAGE_TYPES } from '../constants/messages';

const CHECK_TAB_ALARM = 'checkTab';

console.log('[Background] Script starting...');

// Ensure the keepalive alarm exists on every service worker startup
// (Chrome docs: "ensure it exists each time your service worker starts up")
async function ensureKeepaliveAlarm() {
  try {
    const existing = await chrome.alarms.get(CHECK_TAB_ALARM);
    if (!existing) {
      console.log('[Background] Creating keepalive alarm (every 2 min)');
      createAlarm(CHECK_TAB_ALARM, { periodInMinutes: 2 });
    } else {
      console.log('[Background] Keepalive alarm already exists');
    }
  } catch (error) {
    console.error('[Background] Failed to check/create keepalive alarm:', error);
    // Fallback: always create
    createAlarm(CHECK_TAB_ALARM, { periodInMinutes: 2 });
  }
}

// Initialize suspension and agent state on startup
Promise.all([
  initializeSuspensionState(),
  initializeAutoContactState()
]).then(([resumeAt]) => {
  console.log('[Background] State initialized, resumeAt:', resumeAt);
  if (resumeAt) {
    scheduleResumeAlarm(resumeAt);
    setBadge('PA', 'BuyLead balance 0 - paused', '#f97316');
  } else {
    const state = getSuspensionState();
    if (state.active && state.resumeAt && state.resumeAt <= Date.now()) {
      void resumeAutomationFromSuspension();
    }
  }
  // Start keepalive alarm after state is loaded
  void ensureKeepaliveAlarm();
}).catch((err) => {
  console.error('[Background] State init error:', err);
});

// Listen for alarm events
addAlarmListener((alarm) => {
  console.log('[Background] Alarm triggered:', alarm.name);
  if (alarm.name === RESUME_ALARM_NAME) {
    void resumeAutomationFromSuspension();
  }
  if (alarm.name === CHECK_TAB_ALARM) {
    // Keepalive: if auto-contact is enabled and not suspended, ping the IndiaMart tab
    const suspension = getSuspensionState();
    if (autoContactState.enabled && !autoContactState.stopped && !suspension.active) {
      console.log('[Background] Keepalive: auto-contact enabled, pinging IndiaMart tabs...');
      queryIndiaMARTTabs().then((tabs) => {
        if (tabs.length === 0) {
          console.log('[Background] Keepalive: no IndiaMart tabs found — tab may have been discarded');
          return;
        }
        tabs.forEach((tab) => {
          if (tab.id) {
            sendMessageToTab(tab.id, { type: MESSAGE_TYPES.ENABLE_AUTO_CONTACT }, () => {
              if (chrome.runtime.lastError) {
                console.log('[Background] Keepalive: tab', tab.id, 'did not respond (may need reload)');
              } else {
                console.log('[Background] Keepalive: successfully pinged tab', tab.id);
              }
            });
          }
        });
      }).catch((err) => {
        console.error('[Background] Keepalive: error querying tabs:', err);
      });
    } else {
      console.log('[Background] Keepalive: auto-contact not active, skipping (enabled:', autoContactState.enabled, 'stopped:', autoContactState.stopped, 'suspended:', suspension.active, ')');
    }
  }
});

// Set up message listener
console.log('[Background] Setting up message listener...');
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] Message received:', message.type, message);
  const result = handleMessage(message, sender, sendResponse);
  console.log('[Background] Message handler returned:', result);
  return result;
});

console.log('[Background] Script initialization complete.');