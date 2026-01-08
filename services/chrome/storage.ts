// Chrome extension storage service

export const getStorage = async <T = any>(keys: string | string[] | { [key: string]: any } | null): Promise<{ [key: string]: T }> => {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return {};
  }

  try {
    return await chrome.storage.local.get(keys);
  } catch (error) {
    return {};
  }
};

export const setStorage = async (items: { [key: string]: any }): Promise<void> => {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return;
  }

  try {
    await chrome.storage.local.set(items);
  } catch (error) {
    // Failed to set storage
  }
};

export const removeStorage = async (keys: string | string[]): Promise<void> => {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return;
  }

  try {
    await chrome.storage.local.remove(keys);
  } catch (error) {
    // Failed to remove storage
  }
};

export const addStorageChangeListener = (
  listener: (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void
): void => {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
    return;
  }
  chrome.storage.onChanged.addListener(listener);
};

export const removeStorageChangeListener = (
  listener: (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void
): void => {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
    return;
  }
  chrome.storage.onChanged.removeListener(listener);
};