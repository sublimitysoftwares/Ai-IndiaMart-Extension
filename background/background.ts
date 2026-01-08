// Background script entry point - thin orchestrator

/// <reference types="chrome" />

import { handleMessage } from './messageHandlers';
import { initializeSuspensionState, getSuspensionState } from './stateManager';
import { scheduleResumeAlarm, addAlarmListener } from '../services/chrome/alarms';
import { RESUME_ALARM_NAME } from '../constants/timing';
import { setBadge } from '../services/chrome/badge';
import { resumeAutomationFromSuspension } from './messageHandlers';

// Initialize suspension state on startup
void initializeSuspensionState().then((resumeAt) => {
  if (resumeAt) {
    scheduleResumeAlarm(resumeAt);
    setBadge('PA', 'BuyLead balance 0 - paused', '#f97316');
  } else {
    const state = getSuspensionState();
    if (state.active && state.resumeAt && state.resumeAt <= Date.now()) {
      void resumeAutomationFromSuspension();
    }
  }
});

// Listen for alarm events
addAlarmListener((alarm) => {
  if (alarm.name === RESUME_ALARM_NAME) {
    void resumeAutomationFromSuspension();
  }
});

// Set up message listener
chrome.runtime.onMessage.addListener(handleMessage);