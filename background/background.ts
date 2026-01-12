// Background script entry point - thin orchestrator

/// <reference types="chrome" />

import { handleMessage } from './messageHandlers';
import { initializeSuspensionState, getSuspensionState, initializeAutoContactState } from './stateManager';
import { scheduleResumeAlarm, addAlarmListener } from '../services/chrome/alarms';
import { RESUME_ALARM_NAME } from '../constants/timing';
import { setBadge } from '../services/chrome/badge';
import { resumeAutomationFromSuspension } from './messageHandlers';

console.log('[Background] Script starting...');

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
}).catch((err) => {
  console.error('[Background] State init error:', err);
});

// Listen for alarm events
addAlarmListener((alarm) => {
  console.log('[Background] Alarm triggered:', alarm.name);
  if (alarm.name === RESUME_ALARM_NAME) {
    void resumeAutomationFromSuspension();
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