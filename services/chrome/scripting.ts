// Chrome extension scripting service

export const executeScript = async (
  tabId: number,
  files: string[]
): Promise<void> => {
  if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files
    });
  } catch (error) {
    // Script injection failed (may already be injected)
    if (!(error as Error).message?.includes('Cannot access a chrome')) {
      // Handle other errors if needed
    }
  }
};