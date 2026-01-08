// Chrome extension alarms service

import { RESUME_ALARM_NAME } from '../../constants';

export const clearAlarm = (name: string): void => {
  if (typeof chrome === 'undefined' || !chrome.alarms) {
    return;
  }
  try {
    chrome.alarms.clear(name);
  } catch (error) {
    // Failed to clear alarm
  }
};

export const createAlarm = (name: string, alarmInfo: chrome.alarms.AlarmCreateInfo): void => {
  if (typeof chrome === 'undefined' || !chrome.alarms) {
    return;
  }
  try {
    chrome.alarms.create(name, alarmInfo);
  } catch (error) {
    // Failed to create alarm
  }
};

export const scheduleResumeAlarm = (resumeAt: number): void => {
  clearAlarm(RESUME_ALARM_NAME);
  createAlarm(RESUME_ALARM_NAME, { when: resumeAt });
};

export const addAlarmListener = (
  listener: (alarm: chrome.alarms.Alarm) => void
): void => {
  if (typeof chrome === 'undefined' || !chrome.alarms?.onAlarm) {
    return;
  }
  chrome.alarms.onAlarm.addListener(listener);
};