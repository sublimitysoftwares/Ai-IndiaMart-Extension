// Chrome extension messaging service

export interface ChromeMessage {
  type: string;
  [key: string]: any;
}

export const sendMessage = <T = any>(
  message: ChromeMessage,
  callback?: (response: T) => void
): void => {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return;
  }

  try {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        // Message send failed
        return;
      }
      if (callback) {
        callback(response);
      }
    });
  } catch (error) {
    // Failed to send message
  }
};

export const sendMessageSafe = (message: ChromeMessage): void => {
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

export const sendMessageToTab = (
  tabId: number,
  message: ChromeMessage,
  callback?: (response: any) => void
): void => {
  if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) {
    return;
  }

  try {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        // Message send failed
        return;
      }
      if (callback) {
        callback(response);
      }
    });
  } catch (error) {
    // Failed to send message
  }
};

export const addMessageListener = (
  listener: (message: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => void | boolean
): void => {
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
    return;
  }
  chrome.runtime.onMessage.addListener(listener);
};

export const removeMessageListener = (
  listener: (message: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => void | boolean
): void => {
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
    return;
  }
  chrome.runtime.onMessage.removeListener(listener);
};