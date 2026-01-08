// Chrome extension notifications service

import { NOTIFICATION_ICON_URL } from '../../constants';

export const createNotification = async (
  id: string,
  title: string,
  message: string
): Promise<void> => {
  try {
    if (!chrome.notifications) return;
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: NOTIFICATION_ICON_URL,
      title,
      message,
      priority: 0,
      requireInteraction: false,
      silent: true
    });
  } catch (error) {
    // Failed to create notification
  }
};