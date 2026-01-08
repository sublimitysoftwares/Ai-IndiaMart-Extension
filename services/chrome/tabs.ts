// Chrome extension tabs service

import { TARGET_URL } from '../../constants';

export const queryTabs = (queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> => {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
      resolve([]);
      return;
    }

    try {
      chrome.tabs.query(queryInfo, (tabs) => {
        resolve(tabs || []);
      });
    } catch (error) {
      resolve([]);
    }
  });
};

export const updateTab = (tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined> => {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs?.update) {
      resolve(undefined);
      return;
    }

    try {
      chrome.tabs.update(tabId, updateProperties, (tab) => {
        resolve(tab);
      });
    } catch (error) {
      resolve(undefined);
    }
  });
};

export const createTab = (createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab | undefined> => {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs?.create) {
      resolve(undefined);
      return;
    }

    try {
      chrome.tabs.create(createProperties, (tab) => {
        resolve(tab);
      });
    } catch (error) {
      resolve(undefined);
    }
  });
};

export const queryIndiaMARTTabs = async (): Promise<chrome.tabs.Tab[]> => {
  return queryTabs({ url: '*://seller.indiamart.com/*' });
};

export const queryTargetTab = async (): Promise<chrome.tabs.Tab[]> => {
  return queryTabs({ url: TARGET_URL });
};

export const addTabUpdateListener = (
  listener: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void
): void => {
  if (typeof chrome === 'undefined' || !chrome.tabs?.onUpdated) {
    return;
  }
  chrome.tabs.onUpdated.addListener(listener);
};

export const removeTabUpdateListener = (
  listener: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void
): void => {
  if (typeof chrome === 'undefined' || !chrome.tabs?.onUpdated) {
    return;
  }
  chrome.tabs.onUpdated.removeListener(listener);
};

export const sendMessageToTab = (tabId: number, message: any): Promise<any> => {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) {
      resolve(undefined);
      return;
    }
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        resolve(response);
      });
    } catch (error) {
      resolve(undefined);
    }
  });
};