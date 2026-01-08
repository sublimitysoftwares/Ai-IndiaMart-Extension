// Chrome extension badge service

export const setBadge = (text: string, title: string, color: string): void => {
  try {
    chrome.action?.setBadgeText({ text });
    chrome.action?.setBadgeBackgroundColor?.({ color });
    chrome.action?.setTitle?.({ title });
  } catch (error) {
    // Failed to set badge
  }
};