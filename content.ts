/// <reference types="chrome" />
import type { Lead } from './types';
import { GLOBAL_FLAG } from './constants';
import {
  LEAD_CARD_SELECTORS,
  CONTACT_BUTTON_TEXT,
  SEND_REPLY_TEXT,
  SEND_REPLY_SELECTOR,
  SEND_REPLY_BUTTON_SELECTORS,
  ZERO_BALANCE_REGEXES,
} from './constants/selectors';
import {
  SCRAPE_INTERVAL_MS,
  SCRAPE_MAX_ATTEMPTS,
  WORKING_HOURS,
  WORKING_REFRESH_RANGE_MINUTES,
  OFF_HOURS_REFRESH_RANGE_MINUTES,
  MIN_LEAD_TARGET,
  AUTO_SCROLL_MAX_ATTEMPTS,
  AUTO_SCROLL_DELAY_MS,
  AUTO_SCROLL_COOLDOWN_MS,
  MAX_SCROLL_TIME_MS,
  BACKOFF_ERROR_THRESHOLD,
  BACKOFF_WINDOW_MS,
  BACKOFF_MIN_DELAY_MS,
  BACKOFF_MAX_DELAY_MS,
  CONTACT_HISTORY_RETENTION_MS,
} from './constants/timing';
import {
  DEFAULT_ENQUIRY_KEYWORDS,
  DEFAULT_ALLOWED_CATEGORIES,
  INDIAN_STATES,
  DEFAULT_QUANTITY_THRESHOLD,
  DEFAULT_ORDER_VALUE_MIN,
  CONTACT_HISTORY_WINDOW_DAYS,
} from './constants/filters';
import {
  SKIPPED_LEADS_KEY,
  FILTER_KEYWORDS_KEY,
  FILTER_CATEGORIES_KEY,
  FILTER_QUANTITY_KEY,
  FILTER_ORDER_VALUE_KEY,
  DAILY_CONTACT_STATS_KEY,
  STORAGE_KEYS,
} from './constants/storage';
import { DEFAULT_CONTACT_MESSAGE } from './constants/text';
import {
  sanitize,
  sanitizeOptional,
  parseQuantity,
  parseRupeeRange,
  validateKeyword,
  sanitizeKeyword,
} from './utils/text';
import {
  delay,
  randomBetween,
  randomIntBetween,
  describeScheduleWindow,
  getStealthDelayMs,
  getTodayIdentifier,
} from './utils/time';
import {
  isElementVisible,
  getInteractionContexts,
  setElementValue,
  findElementByText,
  waitForElement,
} from './utils/dom';
import {
  simulateMouseMove,
  simulateHoverDelay,
  simulatePostClickMovement,
  humanScrollBy,
  performHumanScrollPass,
} from './utils/human';

// Wrap everything in an IIFE to prevent redeclaration errors
(() => {
  console.log('[Content] Content script starting...');

  // Check if already loaded
  if ((window as any)[GLOBAL_FLAG]) {
    console.log('[Content] Already loaded, skipping...');
    return;
  }

  // Mark as loaded
  (window as any)[GLOBAL_FLAG] = true;
  console.log('[Content] Marked as loaded, initializing...');

  // State management
  // Auto-contact enabled by default when extension starts
  let isAutoContactEnabled = true;
  let isStopped = false;
  let lastContactTime = 0;
  let processedLeads = new Set<string>();
  let pageRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let processingTimer: ReturnType<typeof setTimeout> | null = null;
  let filteredLeadsCount = 0;
  let contactedLeadsCount = 0;
  let pendingContacts: Lead[] = [];
  let hasLoggedNoLeadCards = false;
  let lastRefreshTime = 0;
  let lastProcessingTime = Date.now();
  let isTabVisible = !document.hidden;
  let lastAutoScrollRun = 0;
  let lastScheduledRefreshWindow = '';
  let lastScheduledProcessingWindow = '';
  let initialScrapeInterval: ReturnType<typeof setInterval> | null = null;
  let isLeadProcessingRunning = false;
  let contactInFlight = false;
  let zeroBalanceDetected = false;
  let zeroBalanceObserver: MutationObserver | null = null;
  let filterConfigLoaded = false; // Track if filter config has been loaded from storage
  let skippedLeads = new Set<string>(); // In-memory set of skipped lead IDs for fast lookups
  let backoffUntil = 0;
  let idlePopupCheckInterval: ReturnType<typeof setInterval> | null = null; // For idle popup watcher
  const recentErrors: number[] = [];

  const stopAutomationTimers = (): void => {
    if (pageRefreshTimer) {
      clearTimeout(pageRefreshTimer);
      pageRefreshTimer = null;
    }
    if (processingTimer) {
      clearTimeout(processingTimer);
      processingTimer = null;
    }
    if (initialScrapeInterval) {
      clearInterval(initialScrapeInterval);
      initialScrapeInterval = null;
    }
    // Stop idle popup watcher
    if (idlePopupCheckInterval) {
      clearInterval(idlePopupCheckInterval);
      idlePopupCheckInterval = null;
    }
    // Stop zero balance observer
    if (zeroBalanceObserver) {
      zeroBalanceObserver.disconnect();
      zeroBalanceObserver = null;
    }
  };

  const resetAutomationState = ({ stopped = false }: { stopped?: boolean } = {}): void => {

    // Stop all timers and observers
    stopAutomationTimers();

    // Reset all state flags
    pendingContacts = [];
    filteredLeadsCount = 0;
    contactedLeadsCount = 0;
    lastRefreshTime = 0;
    lastContactTime = 0;
    hasLoggedNoLeadCards = false;
    isAutoContactEnabled = false;
    isStopped = stopped;
    isLeadProcessingRunning = false;
    contactInFlight = false;
    zeroBalanceDetected = false;

  };

  // Time utilities imported from utils/time

  const registerAutomationError = (reason: string) => {
    const now = Date.now();
    recentErrors.push(now);
    while (recentErrors.length && now - recentErrors[0] > BACKOFF_WINDOW_MS) {
      recentErrors.shift();
    }
    if (recentErrors.length >= BACKOFF_ERROR_THRESHOLD) {
      backoffUntil = now + randomBetween(BACKOFF_MIN_DELAY_MS, BACKOFF_MAX_DELAY_MS);
      recentErrors.length = 0;
      chrome.runtime?.sendMessage?.({
        type: 'AUTOMATION_BACKOFF',
        payload: { resumeAt: backoffUntil, reason },
      });
    }
  };

  const clearAutomationErrors = () => {
    recentErrors.length = 0;
    backoffUntil = Math.min(backoffUntil, Date.now());
  };

  // ========== SCRAPE-ONLY MODE: Store passed leads for testing ==========
  interface PassedLeadLog {
    lead: Lead;
    filterReason: string;
    timestamp: number;
    dateString: string;
    status?: string; // e.g., 'CONTACTED'
  }

  // Store a lead that passed filter criteria to chrome.storage
  const storePassedLead = async (lead: Lead, filterReason: string, status?: string): Promise<void> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      console.log('[Content] storePassedLead - chrome.storage not available');
      return;
    }

    const logEntry: PassedLeadLog = {
      lead,
      filterReason,
      timestamp: Date.now(),
      dateString: new Date().toISOString(),
      status: status || 'UNKNOWN'
    };

    try {
      // Get existing logs
      const result = await chrome.storage.local.get(STORAGE_KEYS.PASSED_LEADS_LOG);
      const existingLogs: PassedLeadLog[] = result[STORAGE_KEYS.PASSED_LEADS_LOG] || [];

      // Check if lead already exists (by leadId)
      const existingIndex = existingLogs.findIndex(entry => entry.lead.leadId === lead.leadId);

      if (existingIndex !== -1) {
        // If it exists but we have a new status (e.g. was UNKNOWN, now CONTACTED), update it
        if (status && existingLogs[existingIndex].status !== status) {
          existingLogs[existingIndex].status = status;
          await chrome.storage.local.set({ [STORAGE_KEYS.PASSED_LEADS_LOG]: existingLogs });
          console.log('[Content] storePassedLead - Updated status for existing lead:', lead.leadId, 'to', status);
        } else {
          console.log('[Content] storePassedLead - Lead already logged:', lead.leadId);
        }
        return;
      }

      // Add new entry
      existingLogs.push(logEntry);

      // Store updated logs
      await chrome.storage.local.set({ [STORAGE_KEYS.PASSED_LEADS_LOG]: existingLogs });
      console.log('[Content] storePassedLead - Stored lead:', lead.leadId, 'Status:', status, 'Total logged:', existingLogs.length);
    } catch (error) {
      console.error('[Content] storePassedLead - Error:', error);
    }
  };

  // Get count of stored passed leads
  const getPassedLeadsCount = async (): Promise<number> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return 0;
    }
    try {
      const result = await chrome.storage.local.get(STORAGE_KEYS.PASSED_LEADS_LOG);
      const logs: PassedLeadLog[] = result[STORAGE_KEYS.PASSED_LEADS_LOG] || [];
      return logs.length;
    } catch {
      return 0;
    }
  };

  // Interface for rejected lead log entry
  interface RejectedLeadLog {
    lead: Lead;
    rejectionReason: string;
    timestamp: number;
    dateString: string;
  }

  // Store a lead that failed filter criteria to chrome.storage
  const storeRejectedLead = async (lead: Lead, rejectionReason: string): Promise<void> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return;
    }

    const logEntry: RejectedLeadLog = {
      lead,
      rejectionReason,
      timestamp: Date.now(),
      dateString: new Date().toISOString(),
    };

    try {
      // Get existing logs
      const result = await chrome.storage.local.get(STORAGE_KEYS.REJECTED_LEADS_LOG);
      const existingLogs: RejectedLeadLog[] = result[STORAGE_KEYS.REJECTED_LEADS_LOG] || [];

      // Check if lead already exists (by leadId)
      const alreadyExists = existingLogs.some(entry => entry.lead.leadId === lead.leadId);
      if (alreadyExists) {
        return;
      }

      // Add new entry
      existingLogs.push(logEntry);

      // Store updated logs
      await chrome.storage.local.set({ [STORAGE_KEYS.REJECTED_LEADS_LOG]: existingLogs });
      console.log('[Content] storeRejectedLead - Stored rejected lead:', lead.leadId, 'Reason:', rejectionReason, 'Total:', existingLogs.length);
    } catch (error) {
      console.error('[Content] storeRejectedLead - Error:', error);
    }
  };
  // ========== END SCRAPE-ONLY MODE ==========

  const syncAutoContactState = () => {
    console.log('[Content] syncAutoContactState called');
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      console.log('[Content] syncAutoContactState - chrome.runtime not available');
      return;
    }

    chrome.runtime.sendMessage({ type: 'GET_AGENT_STATUS' }, (response) => {
      console.log('[Content] syncAutoContactState - GET_AGENT_STATUS response:', response);
      if (chrome.runtime.lastError) {
        console.log('[Content] syncAutoContactState - runtime error:', chrome.runtime.lastError);
        return;
      }

      if (response && response.success) {
        const previousState = isAutoContactEnabled;
        isAutoContactEnabled = Boolean(response.autoContactEnabled);
        isStopped = Boolean(response.agentStopped);
        console.log('[Content] syncAutoContactState - previousState:', previousState, 'isAutoContactEnabled:', isAutoContactEnabled, 'isStopped:', isStopped);

        if (isAutoContactEnabled && !isStopped) {
          if (!previousState) {
            console.log('[Content] syncAutoContactState - Auto-contact newly enabled, starting loops...');
          }
          startScrapeLoop();
          setupPeriodicProcessing();
          setupPeriodicRefresh();
        } else {
          console.log('[Content] syncAutoContactState - Resetting automation (stopped or disabled)');
          resetAutomationState({ stopped: isStopped });
        }
      } else {
        console.log('[Content] syncAutoContactState - No success in response');
      }
    });
  };

  // Text, DOM, and human utilities imported from utils/

  const pickRandomSkipIndexes = (total: number): Set<number> => {
    const skipCount = total <= 3 ? randomIntBetween(0, 1) : randomIntBetween(1, 2);
    const indexes = new Set<number>();
    while (indexes.size < skipCount) {
      const index = randomIntBetween(0, Math.max(0, total - 1));
      indexes.add(index);
      if (indexes.size >= total) break;
    }
    return indexes;
  };

  const applyReadingDelay = async (lead: Lead): Promise<void> => {
    const title = (lead.enquiryTitle || lead.requirement || '').toLowerCase();
    const isPromising = enquiryKeywords.some((keyword) => title.includes(keyword.toLowerCase()));
    const min = isPromising ? 2000 : 1000;
    const max = isPromising ? 5000 : 3000;
    const waitMs = randomBetween(min, max);
    await delay(waitMs);
  };

  // DOM utilities imported from utils/dom

  let bridgeInstalled = false;
  const installClickBridge = (): void => {
    if (bridgeInstalled) return;
    bridgeInstalled = true;

    // Add message listener directly in content script context (no inline script injection to avoid CSP violation)
    // Content scripts already run in the page context, so we can listen directly
    window.addEventListener('message', (event) => {
      // Only handle messages from the same window (our own postMessage calls)
      if (event.source !== window) return;

      const data = event.data;
      if (!data || data.type !== 'AI_CONTACT_BRIDGE_CLICK') return;

      const selector = data.selector;
      if (!selector) return;

      const element = document.querySelector(selector);
      if (!element) return;

      try {
        const mouseInit: MouseEventInit = { bubbles: true, cancelable: true, view: window };

        // Try native click method first (most reliable and CSP-safe)
        if (typeof (element as HTMLElement).click === 'function') {
          (element as HTMLElement).click();
          return;
        }

        // Fallback: dispatch mouse events for elements that don't support .click()
        element.dispatchEvent(new MouseEvent('mousedown', mouseInit));
        element.dispatchEvent(new MouseEvent('mouseup', mouseInit));
        element.dispatchEvent(new MouseEvent('click', mouseInit));

        // If element has onclick property that's a function, try calling it
        // Avoid executing inline onclick strings to prevent CSP issues
        if (typeof (element as any).onclick === 'function') {
          (element as any).onclick.call(element, new MouseEvent('click', mouseInit));
        }
      } catch (error) {
      }
    }, false);
  };

  const triggerRobustClick = async (element: HTMLElement): Promise<void> => {
    installClickBridge();

    try {
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (_) {
      // ignore scroll issues
    }

    if (!element.id) {
      element.id = `auto-contact-btn-${Date.now()}`;
    }

    element.focus({ preventScroll: true });
    await simulateHoverDelay(element);

    const pointerInit: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };
    const mouseInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
    };

    const pointerEvents = ['pointerdown', 'pointerup', 'pointerenter', 'pointerleave'] as const;
    pointerEvents.forEach((type) => {
      const evt = new PointerEvent(type, pointerInit);
      element.dispatchEvent(evt);
    });

    for (const type of ['mousedown', 'mouseup', 'click'] as const) {
      element.dispatchEvent(new MouseEvent(type, mouseInit));
      await delay(randomBetween(30, 60));
    }

    if (typeof element.click === 'function') {
      element.click();
    }

    const bridgeAttribute = 'data-ai-click-id';
    let selector: string | null = null;
    const existingAttr = element.getAttribute(bridgeAttribute);
    if (existingAttr) {
      selector = `[${bridgeAttribute}="${existingAttr}"]`;
    } else {
      const uniqueValue = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      element.setAttribute(bridgeAttribute, uniqueValue);
      selector = `[${bridgeAttribute}="${uniqueValue}"]`;
    }

    if (selector) {
      window.postMessage({ type: 'AI_CONTACT_BRIDGE_CLICK', selector }, '*');
    }
    await simulatePostClickMovement(element);
  };

  const clickWithFallback = async (element: HTMLElement, label: string): Promise<void> => {
    try {
      await triggerRobustClick(element);
    } catch (error) {
    }

    if (!element.isConnected) return;
    await delay(randomBetween(150, 350));

    try {
      element.click();
    } catch (error) {
    }
  };

  const locateContactButton = (card: Element | null, searchDocument: boolean = false): HTMLElement | null => {
    const selectors = [
      'button',
      'a',
      '.btnCBN',
      '.btnCBN1',
      '[data-action="contact"]',
      '[onclick*="contactbuyernow"]',
      '[onclick*="contact"]',
      'button[type="button"]',
      'a[class*="btn"]',
      'button[class*="btn"]',
      '[role="button"]'
    ];

    // If searchDocument is true, prioritize document-wide search (for detail pages)
    const contexts = searchDocument
      ? [document, ...getInteractionContexts(), card].filter(Boolean)
      : card
        ? [card, ...getInteractionContexts()]
        : [document, ...getInteractionContexts()];

    for (const context of contexts) {
      if (
        !(context instanceof Document) &&
        !(context instanceof ShadowRoot) &&
        !(context instanceof HTMLElement)
      ) {
        continue;
      }

      for (const selector of selectors) {
        const candidates = context.querySelectorAll<HTMLElement>(selector);
        for (const candidate of candidates) {
          const label = (candidate.textContent?.trim() || '').toLowerCase();
          const ariaLabel = (candidate.getAttribute('aria-label') || '').toLowerCase();
          const title = (candidate.getAttribute('title') || '').toLowerCase();

          // More flexible text matching for "Contact Buyer Now" button
          const contactBuyerPatterns = [
            'contact buyer',
            'contact buyer now',
            'contactbuyernow',
            'contact buyernow',
            'contactbuyer'
          ];

          const matchesPattern = contactBuyerPatterns.some(pattern =>
            label.includes(pattern) || ariaLabel.includes(pattern) || title.includes(pattern)
          );

          if (!matchesPattern) continue;
          if (isElementVisible(candidate)) {
            return candidate;
          }
        }
      }
    }

    return null;
  };

  // setElementValue imported from utils/dom

  const getVisibleMessageField = (): HTMLElement | null => {
    const contexts = getInteractionContexts();
    for (const ctx of contexts) {
      const candidates = [
        ...Array.from(ctx.querySelectorAll<HTMLTextAreaElement>('textarea')),
        ...Array.from(ctx.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="search"]')),
        ...Array.from(ctx.querySelectorAll<HTMLElement>('[contenteditable="true"]'))
      ];
      for (const candidate of candidates) {
        const element = candidate as HTMLElement;
        if (!isElementVisible(element)) continue;
        const name = (candidate.getAttribute('name') || '').toLowerCase();
        const id = (candidate.id || '').toLowerCase();
        const placeholder = (candidate.getAttribute('placeholder') || '').toLowerCase();
        const ariaLabel = (candidate.getAttribute('aria-label') || '').toLowerCase();
        const role = (candidate.getAttribute('role') || '').toLowerCase();

        const looksLikeMessageField =
          name.includes('message') ||
          id.includes('message') ||
          placeholder.includes('message') ||
          placeholder.includes('reply') ||
          ariaLabel.includes('message') ||
          ariaLabel.includes('reply') ||
          role === 'textbox';

        if (!looksLikeMessageField) continue;
        return element;
      }
    }
    return null;
  };

  const getMessageFieldContent = (): string => {
    const field = getVisibleMessageField();
    if (!field) return '';

    if ((field as HTMLTextAreaElement).value !== undefined) {
      return (field as HTMLTextAreaElement).value || '';
    }
    if ((field as HTMLInputElement).value !== undefined) {
      return (field as HTMLInputElement).value || '';
    }
    return field.textContent || '';
  };

  const fillContactMessage = (message: string): boolean => {
    const field = getVisibleMessageField();
    if (field) {
      setElementValue(field, message);
      return true;
    }
    return false;
  };

  const findSendReplyButton = (): HTMLElement | null => {
    const contexts = getInteractionContexts();
    for (const ctx of contexts) {
      const selectorMatch = ctx.querySelector<HTMLElement>(SEND_REPLY_SELECTOR);
      if (isElementVisible(selectorMatch)) {
        return selectorMatch;
      }
      for (const selector of SEND_REPLY_BUTTON_SELECTORS) {
        const candidate = ctx.querySelector<HTMLElement>(selector);
        if (isElementVisible(candidate)) {
          return candidate;
        }
      }
      const buttonMatch = findElementByText(ctx, 'button, a, div', SEND_REPLY_TEXT);
      if (isElementVisible(buttonMatch)) {
        return buttonMatch;
      }
      const ariaMatch = ctx.querySelector<HTMLElement>('[aria-label*="send reply" i]');
      if (isElementVisible(ariaMatch)) {
        return ariaMatch;
      }
    }
    return null;
  };

  const isSendReplyButtonVisible = (): boolean => {
    const contexts = getInteractionContexts();
    for (const ctx of contexts) {
      for (const selector of SEND_REPLY_BUTTON_SELECTORS) {
        const candidate = ctx.querySelector<HTMLElement>(selector);
        if (isElementVisible(candidate)) {
          return true;
        }
      }
    }
    return false;
  };

  const detectSendReplySuccess = (): boolean => {
    // Strategy 1: CSS class-based success indicators
    const successSelectors = [
      '.toast-success',
      '.alert-success',
      '.success',
      '.thankyou-msg',
      '.submitted',
      '.msg-sent',
      '.message-sent',
      '[data-testid="reply-success"]',
    ];
    const contexts = getInteractionContexts();
    for (const ctx of contexts) {
      for (const selector of successSelectors) {
        const element = ctx.querySelector<HTMLElement>(selector);
        if (isElementVisible(element)) {
          console.log('[Content] detectSendReplySuccess: Found CSS indicator:', selector);
          return true;
        }
      }
    }

    // Strategy 2: Text-based success detection — IndiaMart shows "Your message has been sent successfully"
    // and buttons like "Continue Chat" / "Purchase similar BuyLeads" on success.
    const successTextPatterns = [
      'message has been sent successfully',
      'message sent successfully',
      'sent successfully',
      'successfully sent',
      'your enquiry has been sent',
      'continue chat',
      'purchase similar buyleads',
    ];
    for (const ctx of contexts) {
      // Check all visible elements for success text
      const allElements = ctx.querySelectorAll<HTMLElement>('div, span, p, h1, h2, h3, h4, h5, h6, button, a');
      for (const el of allElements) {
        if (!isElementVisible(el)) continue;
        const text = (el.textContent || '').trim().toLowerCase();
        for (const pattern of successTextPatterns) {
          if (text.includes(pattern)) {
            console.log('[Content] detectSendReplySuccess: Found text indicator:', pattern, 'in element:', el.tagName, el.className);
            return true;
          }
        }
      }
    }

    // Only return true for positive confirmation indicators above.
    // Do NOT assume success just because form elements disappeared.
    return false;
  };

  const waitForSendReplyConfirmation = async (timeoutMs = 6000): Promise<boolean> => {
    const result = await waitForElement(() => (detectSendReplySuccess() ? document.body : null), timeoutMs, 250);
    return Boolean(result);
  };

  const getSendReplyError = (): string | undefined => {
    const selectors = [
      '.error',
      '.error-message',
      '.validation-error',
      '.field-error',
      '[role="alert"]',
      '.toast-error',
      '.alert-danger',
    ];
    const contexts = getInteractionContexts();
    for (const ctx of contexts) {
      for (const selector of selectors) {
        const element = ctx.querySelector<HTMLElement>(selector);
        if (isElementVisible(element)) {
          return sanitize(element.textContent);
        }
      }
    }
    return undefined;
  };

  // Detect expired/consumed lead error modal
  const detectExpiredLeadModal = (): { detected: boolean; modalElement?: HTMLElement; okButton?: HTMLElement } => {
    const contexts = getInteractionContexts();

    // Keywords that indicate expired/consumed lead error
    const errorKeywords = [
      'buylead expired',
      'expired',
      'already consumed',
      'maximum permissible sellers',
      'consumed by maximum',
      'no longer available'
    ];

    // Look for modal/alert elements (includes IndiaMart-specific popup classes)
    const modalSelectors = [
      '.sm_inn_pop_n',
      '#innerPopup',
      '.modal',
      '.alert',
      '.popup',
      '.dialog',
      '[role="dialog"]',
      '[role="alertdialog"]',
      '.modal-content',
      '.alert-box',
      '.error-modal',
      '.warning-modal'
    ];

    for (const ctx of contexts) {
      for (const selector of modalSelectors) {
        const modal = ctx.querySelector<HTMLElement>(selector);
        if (!modal || !isElementVisible(modal)) continue;

        const modalText = sanitize(modal.textContent || '').toLowerCase();

        // Check if modal text contains error keywords
        const hasErrorKeyword = errorKeywords.some(keyword => modalText.includes(keyword));

        if (hasErrorKeyword) {
          // Look for OK button in the modal
          const okButtonSelectors = [
            'button',
            'a[role="button"]',
            '[role="button"]',
            '.btn',
            '.button',
            '.ok-button',
            '.close-button',
            '[aria-label*="ok" i]',
            '[aria-label*="close" i]'
          ];

          for (const btnSelector of okButtonSelectors) {
            const buttons = modal.querySelectorAll<HTMLElement>(btnSelector);
            for (const btn of buttons) {
              if (!isElementVisible(btn)) continue;
              const btnText = sanitize(btn.textContent || '').toLowerCase();
              // Check if button text suggests it's an OK/Close button
              if (btnText.includes('ok') || btnText.includes('close') || btnText.includes('dismiss') ||
                btn.getAttribute('aria-label')?.toLowerCase().includes('ok')) {
                return { detected: true, modalElement: modal, okButton: btn };
              }
            }
          }

          // If modal detected but no OK button found, still return detected
          // We'll try to find OK button elsewhere or use the modal itself
          return { detected: true, modalElement: modal };
        }
      }
    }

    return { detected: false };
  };

  // Load skipped leads from storage
  const loadSkippedLeads = async (): Promise<void> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return;
    }

    try {
      const result = await chrome.storage.local.get([SKIPPED_LEADS_KEY]);
      const storedIds = result[SKIPPED_LEADS_KEY];

      if (Array.isArray(storedIds) && storedIds.length > 0) {
        skippedLeads = new Set(storedIds.filter((id: any) => typeof id === 'string'));
      } else {
        skippedLeads = new Set<string>();
      }
    } catch (error) {
      skippedLeads = new Set<string>();
    }
  };

  // Add a lead ID to the skip list
  const addSkippedLead = async (leadId: string): Promise<void> => {
    if (!leadId || typeof leadId !== 'string') {
      return;
    }

    // Add to in-memory set
    skippedLeads.add(leadId);

    // Save to storage
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return;
    }

    try {
      const idsArray = Array.from(skippedLeads);
      await chrome.storage.local.set({ [SKIPPED_LEADS_KEY]: idsArray });
    } catch (error) {
    }
  };

  // Check if a lead should be skipped
  const isLeadSkipped = (leadId: string): boolean => {
    if (!leadId) return false;
    return skippedLeads.has(leadId);
  };

  // Dismiss expired lead modal by clicking OK button
  // Detect "already purchased" dialog
  const detectAlreadyPurchasedDialog = (): { detected: boolean; dialogElement?: HTMLElement; okButton?: HTMLElement } => {
    try {
      // Look for the specific dialog with id="innerPopup"
      const dialog = document.getElementById('innerPopup') as HTMLElement;

      if (!dialog) {
        return { detected: false };
      }

      // Check if dialog is visible (display: block)
      const style = window.getComputedStyle(dialog);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return { detected: false };
      }

      // Check if dialog contains the "already purchased" text
      const dialogText = dialog.textContent || '';
      if (!dialogText.toLowerCase().includes('already purchased') &&
        !dialogText.toLowerCase().includes('you have already purchased')) {
        return { detected: false };
      }

      // Find the OK button with id="Yes"
      const okButton = document.getElementById('Yes') as HTMLElement;

      if (okButton && isElementVisible(okButton)) {
        // Verify button text contains "OK"
        const buttonText = (okButton.textContent || '').trim().toLowerCase();
        if (buttonText.includes('ok')) {
          return { detected: true, dialogElement: dialog, okButton };
        }
      }

      // Fallback: try to find OK button in the dialog
      if (dialog) {
        const buttons = dialog.querySelectorAll<HTMLElement>('button, .act_btns button');
        for (const btn of buttons) {
          const btnText = (btn.textContent || '').trim().toLowerCase();
          if (btnText.includes('ok') && isElementVisible(btn)) {
            return { detected: true, dialogElement: dialog, okButton: btn };
          }
        }
      }

      // Dialog exists but no OK button found
      if (dialog && isElementVisible(dialog)) {
        return { detected: true, dialogElement: dialog };
      }

      return { detected: false };
    } catch (error) {
      return { detected: false };
    }
  };

  // Dismiss "already purchased" dialog by clicking OK
  const dismissAlreadyPurchasedDialog = async (): Promise<boolean> => {
    const detection = detectAlreadyPurchasedDialog();

    if (!detection.detected) {
      return false;
    }

    try {
      // If we have an OK button, click it
      if (detection.okButton) {
        await clickWithFallback(detection.okButton, 'OK Button (Already Purchased)');
        await delay(1000); // Wait for dialog to close

        // Verify dialog is closed
        const stillVisible = detectAlreadyPurchasedDialog();
        if (!stillVisible.detected) {
          return true;
        } else {
        }
      }

      // Fallback: try to find and click OK button in dialog
      if (detection.dialogElement) {
        const okButtons = detection.dialogElement.querySelectorAll<HTMLElement>(
          'button#Yes, button[onclick*="show_alert_off"], .act_btns button'
        );

        for (const btn of okButtons) {
          const btnText = (btn.textContent || '').trim().toLowerCase();
          if (btnText.includes('ok') && isElementVisible(btn)) {
            await clickWithFallback(btn, 'OK Button (Fallback)');
            await delay(1000);
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      return false;
    }
  };

  const dismissExpiredLeadModal = async (): Promise<boolean> => {
    const detection = detectExpiredLeadModal();

    if (!detection.detected) {
      return false;
    }

    try {
      // If we have an OK button, click it
      if (detection.okButton) {
        await clickWithFallback(detection.okButton, 'OK Button');
        await delay(500); // Wait a bit for modal to close
        return true;
      }

      // Try to find OK button in the modal element
      if (detection.modalElement) {
        const okButtons = detection.modalElement.querySelectorAll<HTMLElement>(
          'button, a[role="button"], [role="button"], .btn, .button'
        );

        for (const btn of okButtons) {
          if (!isElementVisible(btn)) continue;
          const btnText = sanitize(btn.textContent || '').toLowerCase();
          if (btnText.includes('ok') || btnText.includes('close') || btnText.includes('dismiss')) {
            await clickWithFallback(btn, 'OK Button');
            await delay(500);
            return true;
          }
        }

        // Last resort: try pressing Escape key
        detection.modalElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await delay(500);
        return true;
      }
    } catch (error) {
    }

    return false;
  };

  const composeContactMessage = (lead?: Lead): string => {
    const greeting = lead?.companyName ? `Hello ${lead.companyName},` : 'Hello,';
    const requirement = lead?.enquiryTitle ? `regarding "${lead.enquiryTitle}"` : 'regarding your requirement';
    const location = lead?.location ? ` in ${lead.location}` : '';
    return `${greeting}\n\nWe supply premium-quality uniforms and would love to support your needs ${requirement}${location}. Please share sizes and timelines so we can offer the best quote.\n\nThanks,\nTeam IndiaMART Agent`;
  };

  const getInputValue = (root: Document | Element | ShadowRoot, selector: string): string | undefined => {
    const input = root.querySelector<HTMLInputElement>(selector);
    return sanitizeOptional(input?.value);
  };

  const getTableValue = (root: Element, label: string): string | undefined => {
    const normalized = label.trim().toLowerCase();
    const rows = Array.from(root.querySelectorAll<HTMLTableRowElement>('tr'));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll<HTMLTableCellElement>('td'));
      if (!cells.length) continue;
      const heading = sanitize(cells[0]?.textContent).replace(/[:：]/g, '').toLowerCase();
      if (!heading) continue;
      if (heading === normalized || heading.includes(normalized)) {
        const valueCell = cells.slice(1).find((cell) => sanitize(cell.textContent)) || cells[1] || cells[0];
        if (!valueCell) continue;
        const rawValue =
          valueCell.querySelector('b, strong')?.textContent ||
          valueCell.textContent ||
          '';
        const cleaned = sanitize(rawValue.replace(/^[:：\s]+/, ''));
        if (cleaned) {
          return cleaned;
        }
      }
    }
    return undefined;
  };

  // parseQuantity and parseRupeeRange imported from utils/text

  const describeContext = (ctx: Document | ShadowRoot, index: number): string => {
    if (ctx === document) return 'document';
    const ownerNode = (ctx as ShadowRoot).host;
    if (ownerNode) {
      const id = (ownerNode as HTMLElement).id ? `#${(ownerNode as HTMLElement).id}` : ownerNode.tagName.toLowerCase();
      return `shadow-root(${id})`;
    }
    return `context-${index}`;
  };

  const getLeadSearchContexts = (): (Document | ShadowRoot)[] => {
    const contexts: (Document | ShadowRoot)[] = [document];
    const iframes = Array.from(document.querySelectorAll('iframe'));
    iframes.forEach((frame) => {
      try {
        const doc = frame.contentDocument || frame.contentWindow?.document;
        if (doc && doc.body) {
          contexts.push(doc);
        }
      } catch (error) {
      }
    });

    // Include known shadow roots if present
    const shadowHosts = Array.from(document.querySelectorAll<HTMLElement>('[data-shadow-host="lead"], indiamart-lead-feed')); // heuristic selectors
    shadowHosts.forEach((host) => {
      if (host.shadowRoot) {
        contexts.push(host.shadowRoot);
      }
    });

    return contexts;
  };

  const getLeadCardElements = (): HTMLElement[] => {
    console.log('[Content] getLeadCardElements called');
    const contexts = getLeadSearchContexts();
    console.log('[Content] getLeadCardElements - Searching in', contexts.length, 'contexts');
    const seen = new Set<HTMLElement>();
    const cards: HTMLElement[] = [];

    contexts.forEach((ctx, ctxIndex) => {
      const contextLabel = describeContext(ctx, ctxIndex);
      LEAD_CARD_SELECTORS.forEach((selector) => {
        const matches = Array.from(ctx.querySelectorAll<HTMLElement>(selector));
        if (matches.length > 0) {
          console.log('[Content] getLeadCardElements - Found', matches.length, 'matches for selector:', selector, 'in context:', contextLabel);
        }
        matches.forEach((match) => {
          if (!seen.has(match)) {
            seen.add(match);
            cards.push(match);
          }
        });
      });
    });

    console.log('[Content] getLeadCardElements - Total unique cards found:', cards.length);
    if (cards.length === 0) {
      console.log('[Content] getLeadCardElements - No lead cards found! Selectors used:', LEAD_CARD_SELECTORS);
      if (!hasLoggedNoLeadCards) {
        hasLoggedNoLeadCards = true;
      }
    } else {
      hasLoggedNoLeadCards = false;
    }

    return cards;
  };

  // delay imported from utils/time

  const withContactLock = async <T>(task: () => Promise<T>): Promise<T> => {
    while (contactInFlight) {
      await delay(200);
    }
    contactInFlight = true;
    try {
      return await task();
    } finally {
      contactInFlight = false;
    }
  };



  const detectZeroBalancePopup = (): boolean => {
    if (!document.body || zeroBalanceDetected) {
      return false;
    }

    try {
      const bodyText = document.body.innerText?.toLowerCase() || '';
      if (!bodyText) return false;
      return ZERO_BALANCE_REGEXES.some((regex) => regex.test(bodyText));
    } catch (error) {
      return false;
    }
  };

  const getBuyLeadBalanceEstimate = (): number | undefined => {
    if (!document.body) return undefined;
    try {
      const text = document.body.innerText;
      if (!text) return undefined;
      const match = text.match(/buy\s*lead(?:s)?\s*balance\s*[:\-]?\s*([0-9,]+)/i);
      if (!match) return undefined;
      const value = Number(match[1].replace(/[^0-9]/g, ''));
      return Number.isFinite(value) ? value : undefined;
    } catch (error) {
      return undefined;
    }
  };

  const notifyZeroBalanceSuspension = () => {
    try {
      chrome.runtime.sendMessage({ type: 'BUY_LEAD_BALANCE_ZERO' });
    } catch (error) {
    }
  };

  const handleZeroBalanceDetected = () => {
    if (zeroBalanceDetected) {
      return;
    }

    zeroBalanceDetected = true;
    if (zeroBalanceObserver) {
      zeroBalanceObserver.disconnect();
      zeroBalanceObserver = null;
    }

    resetAutomationState({ stopped: true });
    notifyZeroBalanceSuspension();
  };

  const startZeroBalanceObserver = () => {
    if (zeroBalanceObserver) {
      zeroBalanceObserver.disconnect();
    }

    if (detectZeroBalancePopup()) {
      handleZeroBalanceDetected();
      return;
    }

    zeroBalanceObserver = new MutationObserver(() => {
      if (zeroBalanceDetected) {
        return;
      }

      if (detectZeroBalancePopup()) {
        handleZeroBalanceDetected();
      }
    });

    if (document.body) {
      zeroBalanceObserver.observe(document.body, { childList: true, subtree: true });
    }
  };

  const attemptClickLoadMore = (): boolean => {
    // DO NOT click "SHOW MORE BUYLEADS" button - we only want to scroll to it, not click it
    // Check all buttons but skip "SHOW MORE BUYLEADS" buttons
    const allButtons = document.querySelectorAll<HTMLElement>('button, a[role="button"], [role="button"]');
    for (const btn of allButtons) {
      const btnText = (btn.textContent || '').trim().toUpperCase();
      // Skip "SHOW MORE BUYLEADS" buttons - we don't want to click these
      if (btnText.includes('SHOW MORE BUYLEADS') || btnText.includes('SHOW MORE BUY LEADS')) {
        continue; // Skip this button, don't click it
      }
    }

    // Fallback: Try selectors, but exclude buttons with "SHOW MORE BUYLEADS" text
    const selectors = [
      'button.load-more',
      'button.loadMore',
      'button[data-testid*="load"]',
      'button[data-action*="load"]',
      '[role="button"][aria-label*="Load"]',
      '[role="button"][aria-label*="Show More"]',
      '.loadMoreBtn',
      '.view-more',
      '.showMore',
      'a.load-more',
    ];
    for (const selector of selectors) {
      const btn = document.querySelector<HTMLElement>(selector);
      if (btn && isElementVisible(btn) && !btn.getAttribute('aria-disabled')) {
        const btnText = (btn.textContent || '').trim().toUpperCase();
        // Skip "SHOW MORE BUYLEADS" buttons
        if (btnText.includes('SHOW MORE BUYLEADS') || btnText.includes('SHOW MORE BUY LEADS')) {
          continue; // Skip this button, don't click it
        }
        btn.scrollIntoView({ behavior: 'auto', block: 'center' });
        btn.click();
        return true;
      }
    }
    return false;
  };

  const findShowMoreButton = (): HTMLElement | null => {
    // First, check for "Show More Suggested Leads" button by class and text
    const showMoreSuggestedBtn = document.querySelector<HTMLElement>('button.show_more');
    if (showMoreSuggestedBtn) {
      const btnText = (showMoreSuggestedBtn.textContent || '').trim();
      if (btnText.includes('Show More Suggested Leads') &&
        isElementVisible(showMoreSuggestedBtn) &&
        !showMoreSuggestedBtn.getAttribute('aria-disabled')) {
        return showMoreSuggestedBtn;
      }
    }

    // Search for "Show More Suggested Leads" button by text (case-insensitive)
    // DO NOT return "SHOW MORE BUYLEADS" buttons - we only want to detect "Show More Suggested Leads"
    const allButtons = document.querySelectorAll<HTMLElement>('button, a[role="button"], [role="button"]');
    for (const btn of allButtons) {
      const btnText = (btn.textContent || '').trim();
      const btnTextUpper = btnText.toUpperCase();

      // Skip "SHOW MORE BUYLEADS" buttons - we don't want to detect these
      if (btnTextUpper.includes('SHOW MORE BUYLEADS') || btnTextUpper.includes('SHOW MORE BUY LEADS')) {
        continue; // Skip this button
      }

      // Check for "Show More Suggested Leads" button
      if (btnText.includes('Show More Suggested Leads') &&
        isElementVisible(btn) &&
        !btn.getAttribute('aria-disabled')) {
        return btn;
      }
    }
    return null;
  };

  const ensureMinimumLeadCards = async (
    minCount = MIN_LEAD_TARGET,
    maxAttempts = AUTO_SCROLL_MAX_ATTEMPTS,
    delayMs = AUTO_SCROLL_DELAY_MS
  ): Promise<void> => {
    console.log('[Content] ensureMinimumLeadCards called. minCount:', minCount, 'maxAttempts:', maxAttempts);
    const existing = getLeadCardElements().length;
    console.log('[Content] ensureMinimumLeadCards - Existing lead cards:', existing);

    // Check if "Show More Suggested Leads" button is already visible
    const showMoreBtnCheck = findShowMoreButton();
    if (showMoreBtnCheck && isElementVisible(showMoreBtnCheck)) {
      const btnText = (showMoreBtnCheck.textContent || '').trim();
      console.log('[Content] ensureMinimumLeadCards - Found show more button:', btnText);
      // Check if it's the "Show More Suggested Leads" button (not "SHOW MORE BUYLEADS")
      if (btnText.includes('Show More Suggested Leads')) {
        console.log('[Content] ensureMinimumLeadCards - Scrolling to Show More Suggested Leads button');
        // Scroll to it to ensure it's fully in view, then stop
        showMoreBtnCheck.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await delay(1000);
        return;
      }
    } else {
      console.log('[Content] ensureMinimumLeadCards - No show more button found yet');
    }

    const now = Date.now();
    // Remove cooldown restriction - allow continuous scrolling
    if (existing >= minCount && now - lastAutoScrollRun < AUTO_SCROLL_COOLDOWN_MS) {
      console.log('[Content] ensureMinimumLeadCards - Skipping due to cooldown or enough leads');
      return;
    }
    lastAutoScrollRun = now;
    console.log('[Content] ensureMinimumLeadCards - Starting auto-scroll loop...');

    const startTime = Date.now();
    let attempt = 0;
    let previousCount = existing;
    let noProgressCount = 0; // Track consecutive attempts with no progress

    let showMoreButtonFound = false;

    while (attempt < maxAttempts) {
      // Check timeout: if 5 minutes elapsed, break to avoid infinite scrolling
      if (Date.now() - startTime > MAX_SCROLL_TIME_MS) {
        break;
      }

      attempt += 1;

      // Check for "Show More Suggested Leads" button - scroll until it's visible, then stop (don't click)
      const showMoreBtn = findShowMoreButton();
      if (showMoreBtn && isElementVisible(showMoreBtn)) {
        const btnText = (showMoreBtn.textContent || '').trim();
        // Only stop for "Show More Suggested Leads", not "SHOW MORE BUYLEADS"
        if (btnText.includes('Show More Suggested Leads')) {
          if (!showMoreButtonFound) {
            showMoreButtonFound = true;
          }

          // Scroll to button to ensure it's fully visible
          showMoreBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await delay(1000); // Wait for scroll to complete

          // Verify button is still visible after scroll
          const currentBtn = findShowMoreButton();
          if (currentBtn && isElementVisible(currentBtn)) {
            break; // Stop scrolling - don't click the button
          }
        }
      }

      // Scroll to absolute bottom more frequently to ensure we're loading all content
      if (attempt % 3 === 0) {
        const scrollHeight = Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight
        );
        window.scrollTo({ top: scrollHeight, behavior: 'auto' });
        await delay(2000); // Wait longer for content to load after scrolling to bottom
      }

      // 1 second per lead scrolling: always scroll down, no random checks
      await performHumanScrollPass();

      // Try clicking "Load More" button (fallback - in case button text changes)
      const clicked = attemptClickLoadMore();
      if (clicked && !showMoreButtonFound) {
        await delay(2000); // Wait longer after clicking Load More
      }

      // Always scroll down after checking for load more button - larger distances
      await humanScrollBy(randomBetween(700, 1000)); // Much larger scroll distance to ensure reaching 50 leads

      // Scroll even more to ensure we're past any lazy-loading thresholds
      await humanScrollBy(randomBetween(400, 600));

      // Additional scroll pass for maximum coverage
      await humanScrollBy(randomBetween(200, 400));

      // 1 second delay between attempts (approximately 1 second per lead)
      await delay(delayMs); // Fixed 1 second delay

      // Wait longer for any dynamically loaded content to ensure leads are detected
      await delay(800);

      const currentCount = getLeadCardElements().length;

      // Check again for "Show More Suggested Leads" button - it might appear after scrolling
      const newShowMoreBtn = findShowMoreButton();
      if (newShowMoreBtn && isElementVisible(newShowMoreBtn)) {
        const btnText = (newShowMoreBtn.textContent || '').trim();
        // If "Show More Suggested Leads" button is visible, stop scrolling (don't click)
        if (btnText.includes('Show More Suggested Leads')) {
          if (!showMoreButtonFound) {
            showMoreButtonFound = true;
          }
          // Scroll to button to ensure it's fully visible, then stop
          newShowMoreBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await delay(1000);
          break;
        }
      }

      // Continue scrolling if button not found yet
      if (!showMoreButtonFound && currentCount >= minCount) {
        // We have enough leads, but still scroll until we find the button
      }

      // Track progress - continue scrolling even if no progress for a while
      if (currentCount > previousCount) {
        noProgressCount = 0; // Reset no progress counter
      } else {
        noProgressCount++;

        // HARD EXIT: If no new leads loaded after 15 consecutive attempts, stop scrolling.
        // This prevents infinite scrolling when IndiaMart has fewer leads than MIN_LEAD_TARGET.
        if (noProgressCount >= 15) {
          console.log('[Content] ensureMinimumLeadCards - No progress after 15 attempts, stopping scroll. Current count:', currentCount);
          break;
        }

        // Only warn if no progress for many attempts, but keep scrolling
        if (noProgressCount > 5 && noProgressCount % 3 === 0) {
          // Try scrolling to bottom again if no progress - more aggressive
          const scrollHeight = Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight
          );
          window.scrollTo({ top: scrollHeight, behavior: 'auto' });
          await delay(2500); // Wait for content to load
          // Scroll a bit more after reaching bottom
          await humanScrollBy(randomBetween(500, 800));
          await delay(1500);
        }
      }

      previousCount = currentCount;
    }

    const finalCount = getLeadCardElements().length;
    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);

    // Don't refresh immediately - wait for 30 second refresh cycle
    if (finalCount >= minCount && isAutoContactEnabled && !isStopped) {
    }
  };

  const buildLeadId = (card: Element, index: number, title: string, timestamp: string): string => {
    const attrId = card.getAttribute('data-lead-id');
    if (attrId) return attrId;

    const hiddenId =
      getInputValue(card, 'input[name="ofrid"], input[id^="ofrid"], input[name^="ofrid"]') ||
      getInputValue(card, 'input[name="gridParam"], input[name^="gridParam"], input[id^="gridParam"]');
    if (hiddenId) return hiddenId;

    return `${index}-${title || 'lead'}-${timestamp || 'time'}`.replace(/\s+/g, '-');
  };

  const extractLead = (card: Element, index: number): Lead => {
    const primaryTitle = sanitizeOptional(card.querySelector('h1, h2, h3, .bl-title, .enquiry-title')?.textContent);
    const ofrTitle = getInputValue(card, 'input[name="ofrtitle"], input[id^="ofrtitle"], input[name^="ofrtitle"]');

    const companyName =
      sanitizeOptional(card.querySelector('p.bl-compNm, .company-name')?.textContent) ||
      sanitizeOptional(card.querySelector('.lstNwRgtBD .alignBox b, .lstNwRgtBD .buyer-name')?.textContent) ||
      'N/A';

    const requirement =
      sanitizeOptional(card.querySelector('p.bl-enq-comp, .requirement')?.textContent) ||
      ofrTitle ||
      primaryTitle ||
      'No requirement specified.';

    // Extract city - exclude nested tooltip spans (.stltips)
    const cityElement = card.querySelector('.lstNwLftLoc .city_click, .city_click');
    let city = '';
    if (cityElement) {
      // Clone element and remove tooltip spans before extracting text
      const cityClone = cityElement.cloneNode(true) as HTMLElement;
      cityClone.querySelectorAll('.stltips').forEach(el => el.remove());
      city = sanitizeOptional(cityClone.textContent) || '';
    }
    // Fallback to input value if not found
    city = city || getInputValue(card, 'input[id^="card_city"], input[name^="card_city"]') || '';

    // Extract state - exclude nested tooltip spans (.stltips)
    const stateElement = card.querySelector('.lstNwLftLoc .state_click, .state_click');
    let state = '';
    if (stateElement) {
      // Clone element and remove tooltip spans before extracting text
      const stateClone = stateElement.cloneNode(true) as HTMLElement;
      stateClone.querySelectorAll('.stltips').forEach(el => el.remove());
      state = sanitizeOptional(stateClone.textContent) || '';
    }
    // Fallback to input value if not found
    state = state || getInputValue(card, 'input[id^="card_state"], input[name^="card_state"]') || '';

    // Try to get location from dedicated location element, but filter out tooltip text
    const locationElement = card.querySelector('li[title="Location"] span, .location');
    let locationText = '';

    if (locationElement) {
      // Use innerText instead of textContent to get only visible text (excludes hidden tooltips)
      locationText = sanitizeOptional((locationElement as HTMLElement).innerText || locationElement.textContent || '') || '';

      // Remove tooltip patterns like "Click here to view BuyLeads from..."
      locationText = locationText
        .replace(/Click here to view BuyLeads from[^]*?$/gi, '')
        .replace(/Click here[^]*?$/gi, '')
        .trim();

      // If text still contains tooltip keywords or is too long, prefer city+state combination
      if (locationText.includes('Click here') ||
        locationText.length > 100 ||
        locationText.split(',').length > 3) {
        locationText = '';
      }
    }

    // Prioritize city+state combination as it's more reliable
    const location =
      [city, state].filter(Boolean).join(', ') ||
      (locationText ? locationText : 'N/A');

    const offerDate = getInputValue(card, 'input[name="offerdate"], input[id^="offerdate"], input[id^="ofrdate"], input[name^="ofrdate"]');
    const timestamp =
      offerDate ||
      sanitizeOptional(card.querySelector('li[title="Date"] span, time, .date, .lstNwLftLoc strong')?.textContent) ||
      'N/A';

    const quantityText =
      getTableValue(card as HTMLElement, 'Quantity') ||
      sanitizeOptional(card.querySelector('.bl-qty, [class*="quantity"], li[title="Quantity"], li:has(span.bl-qty)')?.textContent);
    const quantityMatch = card.textContent?.match(/Quantity\s*[:\-]?\s*([\d.,]+)/i);
    const quantityInfo = parseQuantity(quantityText || quantityMatch?.[1]);

    const categoryText =
      sanitizeOptional(card.querySelector('li[title="I am interested in"], .bl-interest, .bl-category a, .bl-category span')?.textContent) ||
      getInputValue(card, 'input[name="mcatname"], input[id^="mcatname"], input[name^="mcatname"]') ||
      undefined;

    let fabricElement = card.querySelector('[class*="fabric"], li[title="Fabric"] span');
    if (!fabricElement) {
      const fabricLi = Array.from(card.querySelectorAll('li')).find((li) =>
        li.textContent?.toLowerCase().includes('fabric')
      );
      if (fabricLi) {
        fabricElement =
          fabricLi.querySelector('span, strong, b') ||
          (fabricLi as HTMLElement);
      }
    }
    const fabricText = getTableValue(card as HTMLElement, 'Fabric') || sanitizeOptional(fabricElement?.textContent);

    // Order Value scraping: IndiaMart uses <li> elements, and the label can be
    // "Order Value" or "Probable Order Value" depending on the page/card layout.
    const orderValueNode = card.querySelector('li[title="Probable Order Value"], li[title="Order Value"], .bl-order-value, .probable-order');
    let orderValueText =
      getTableValue(card as HTMLElement, 'Probable Order Value') ||
      getTableValue(card as HTMLElement, 'Order Value') ||
      sanitizeOptional(orderValueNode?.textContent);
    // Fallback: search <li> elements by text content (same pattern as fabric scraping)
    if (!orderValueText) {
      const orderValueLi = Array.from(card.querySelectorAll('li')).find((li) =>
        /order\s*value/i.test(li.textContent || '')
      );
      if (orderValueLi) {
        const valueEl = orderValueLi.querySelector('span, strong, b');
        orderValueText = sanitizeOptional(valueEl?.textContent) || sanitizeOptional(orderValueLi.textContent);
      }
    }
    // Final fallback: regex on full card text for both "Order Value" and "Probable Order Value"
    if (!orderValueText) {
      orderValueText = card.textContent?.match(/(?:Probable\s+)?Order\s+Value\s*[:\-]?\s*([^\n]+)/i)?.[1] || undefined;
    }
    const orderValueInfo = parseRupeeRange(orderValueText || undefined);

    const enquiryTitle = primaryTitle || ofrTitle || requirement;
    const leadId = buildLeadId(card, index, enquiryTitle || '', timestamp || '');

    return {
      leadId,
      companyName,
      enquiryTitle,
      requirement,
      contactInfo: 'Contact info may require interaction',
      location,
      timestamp,
      quantityRaw: quantityInfo.raw,
      quantity: quantityInfo.quantity,
      category: categoryText || undefined,
      fabric: fabricText || undefined,
      probableOrderValueRaw: orderValueInfo.raw,
      probableOrderValueMin: orderValueInfo.min,
      probableOrderValueMax: orderValueInfo.max,
      cardIndex: index,
    };
  };

  const scrapeLeads = (): Lead[] => {
    console.log('[Content] scrapeLeads called');
    const cards = getLeadCardElements();
    console.log('[Content] scrapeLeads - Found', cards.length, 'lead cards on page');
    const leads = cards.map((card, index) => extractLead(card, index));
    console.log('[Content] scrapeLeads - Extracted', leads.length, 'leads');
    if (leads.length > 0) {
      console.log('[Content] scrapeLeads - First lead:', leads[0]);
    }
    return leads;
  };

  // findElementByText and waitForElement imported from utils/dom

  const performContactFlow = async (cardIndex: number, lead?: Lead): Promise<{ success: boolean; error?: string }> => {
    const shouldAbort = () => isStopped || !isAutoContactEnabled;
    if (shouldAbort()) {
      return { success: false, error: 'Auto-contact disabled.' };
    }

    console.log('[Content] ===== performContactFlow START =====');
    console.log('[Content] Intended lead:', lead?.leadId, '|', lead?.enquiryTitle, '|', lead?.companyName);

    // ═══════════════════════════════════════════════════════════
    //  STEP 1: Find the EXACT card on the page that matches our lead.
    //  NEVER trust cardIndex alone — the DOM can reshuffle.
    // ═══════════════════════════════════════════════════════════
    const cards = getLeadCardElements();
    let card: Element | undefined;

    if (lead) {
      const enquiryTitleLower = (lead.enquiryTitle || '').toLowerCase();
      const companyNameLower = (lead.companyName || '').toLowerCase();
      const leadIdStr = lead.leadId || '';

      // First try the suggested cardIndex, but VERIFY it matches
      if (cards[cardIndex]) {
        const candidateText = (cards[cardIndex].textContent || '').toLowerCase();
        const indexMatches =
          (enquiryTitleLower && candidateText.includes(enquiryTitleLower)) ||
          (companyNameLower && companyNameLower !== 'n/a' && candidateText.includes(companyNameLower)) ||
          (leadIdStr && candidateText.includes(leadIdStr));

        if (indexMatches) {
          card = cards[cardIndex];
          console.log('[Content] Card at index', cardIndex, 'verified ✓ matches lead', lead.leadId);
        } else {
          console.log('[Content] Card at index', cardIndex, 'does NOT match lead', lead.leadId, '— will search all cards');
        }
      }

      // If cardIndex didn't match, search ALL cards
      if (!card) {
        for (let i = 0; i < cards.length; i++) {
          const testCard = cards[i];
          const testText = (testCard.textContent || '').toLowerCase();

          if ((enquiryTitleLower && testText.includes(enquiryTitleLower)) ||
            (companyNameLower && companyNameLower !== 'n/a' && testText.includes(companyNameLower)) ||
            (leadIdStr && testText.includes(leadIdStr))) {
            card = testCard;
            console.log('[Content] Found matching card at index', i, 'for lead', lead.leadId);
            break;
          }
        }
      }

      // HARD ABORT if no card matches — never click a random card
      if (!card) {
        console.log('[Content] ✗ ABORT: No card on page matches lead', lead.leadId, lead.enquiryTitle, '— refusing to click anything');
        return { success: false, error: 'No matching card found on page. Aborting to prevent wrong lead click.' };
      }
    } else {
      // No lead data provided — use cardIndex as last resort
      card = cards[cardIndex];
      if (!card) {
        return { success: false, error: 'Card not found at index ' + cardIndex };
      }
    }

    // Detect if we're on a detail page (no cards found or card not available)
    const isDetailPage = !card || cards.length === 0;

    // Scroll card into view
    if (card && card instanceof HTMLElement) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(1000);
    } else if (isDetailPage) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await delay(1000);
    }

    // ═══════════════════════════════════════════════════════════
    //  STEP 2: Find the Contact Buyer Now button STRICTLY INSIDE the card.
    //  NO document-wide search. NO iframe search. Card only.
    // ═══════════════════════════════════════════════════════════

    // First, hover over the card to trigger IndiaMart's hover-to-show behavior
    // (Contact Buyer Now buttons may be hidden until hover)
    if (card && card instanceof HTMLElement) {
      card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      simulateMouseMove(card);
      await delay(500); // Wait for hover CSS/JS to reveal hidden buttons
    }

    const findButtonInCard = (searchCard: Element): HTMLElement | null => {
      // Strategy A: Find visible button by text "Contact Buyer Now"
      const allClickables = searchCard.querySelectorAll<HTMLElement>('button, a, [role="button"]');
      for (const el of allClickables) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (text.includes('contact buyer') && isElementVisible(el)) {
          return el;
        }
      }

      // Strategy B: Find by CSS class patterns (visible)
      const btnSelectors = [
        '.btnCBN', '.btnCBN1', '[data-action="contact"]',
        '[onclick*="contactbuyernow"]', '.btnCBNContainer button',
        '.btnCBNContainer a'
      ];
      for (const sel of btnSelectors) {
        const btn = searchCard.querySelector<HTMLElement>(sel);
        if (btn && isElementVisible(btn)) return btn;
      }

      // Strategy C FALLBACK: Find button even if NOT visible (hover may not have triggered it)
      // We'll make it visible by scrolling + hovering after finding it
      for (const el of allClickables) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (text.includes('contact buyer')) {
          console.log('[Content] Found hidden Contact Buyer button — will try to reveal it');
          return el;
        }
      }

      // Strategy D FALLBACK: Find by CSS class even if not visible
      for (const sel of btnSelectors) {
        const btn = searchCard.querySelector<HTMLElement>(sel);
        if (btn) {
          console.log('[Content] Found hidden button via selector', sel, '— will try to reveal it');
          return btn;
        }
      }

      return null;
    };

    const contactButton = await waitForElement(() => {
      if (card) {
        // Strategy 1: Search inside the card itself
        const insideCard = findButtonInCard(card);
        if (insideCard) return insideCard;

        // Strategy 2: Search parent containers (up to 5 levels up)
        // IndiaMart expands cards into detail views — the Contact Buyer Now
        // button is often in a parent container, not inside the original card div.
        let ancestor = card.parentElement;
        for (let level = 0; level < 5 && ancestor; level++) {
          const inAncestor = findButtonInCard(ancestor);
          if (inAncestor) {
            console.log('[Content] Found Contact Buyer button in parent level', level + 1);
            return inAncestor;
          }
          ancestor = ancestor.parentElement;
        }

        // Strategy 3: Search next/previous siblings
        const siblings = [card.nextElementSibling, card.previousElementSibling];
        for (const sib of siblings) {
          if (!sib) continue;
          const inSibling = findButtonInCard(sib);
          if (inSibling) {
            console.log('[Content] Found Contact Buyer button in sibling element');
            return inSibling;
          }
        }
      }
      // Detail page fallback — only when there are no cards at all
      if (isDetailPage) {
        return findButtonInCard(document.body);
      }
      return null;
    }, 15000);

    if (shouldAbort()) {
      return { success: false, error: 'Auto-contact disabled.' };
    }

    if (!contactButton) {
      console.log('[Content] ✗ ABORT: Contact Buyer Now button not found inside the matched card');
      return { success: false, error: 'Contact Buyer Now button not found inside the matched card.' };
    }

    // If button was found but might be hidden, try to make it visible
    // (Avoid isElementVisible type guard which narrows contactButton to 'never')
    const btnStyle = window.getComputedStyle(contactButton);
    const btnRect = contactButton.getBoundingClientRect();
    const btnCurrentlyHidden = btnStyle.display === 'none' || btnStyle.visibility === 'hidden' ||
      Number(btnStyle.opacity) === 0 || btnRect.width === 0 || btnRect.height === 0;

    if (btnCurrentlyHidden) {
      console.log('[Content] Button found but hidden — trying to reveal via scroll + hover');
      contactButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(500);
      if (card && card instanceof HTMLElement) {
        card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        simulateMouseMove(card);
        await delay(800);
      }
    }

    // ═══════════════════════════════════════════════════════════
    //  STEP 3: Cross-check — verify the button is for the RIGHT lead
    //  by checking if button's href/onclick contains the lead's ID.
    // ═══════════════════════════════════════════════════════════
    if (lead && lead.leadId) {
      const btnHref = contactButton.getAttribute('href') || '';
      const btnOnclick = contactButton.getAttribute('onclick') || '';
      const btnDataAttrs = Array.from(contactButton.attributes)
        .map(attr => attr.value)
        .join(' ');

      // Log button details for debugging
      console.log('[Content] Button href:', btnHref.substring(0, 100));
      console.log('[Content] Button onclick:', btnOnclick.substring(0, 100));
      console.log('[Content] Lead ID to verify:', lead.leadId);

      // Only verify if button has href/onclick (some buttons are plain divs)
      if (btnHref || btnOnclick) {
        const buttonRefersToLead =
          btnHref.includes(lead.leadId) ||
          btnOnclick.includes(lead.leadId) ||
          btnDataAttrs.includes(lead.leadId);

        if (!buttonRefersToLead) {
          // Check if this is a numeric leadId and the button contains it
          // Sometimes IDs are embedded differently
          console.log('[Content] ⚠ WARNING: Button href/onclick does not contain leadId', lead.leadId);
          console.log('[Content] Proceeding with caution — card text was verified to match');
        }
      }
    }

    console.log('[Content] ✓ Clicking Contact Buyer Now for lead:', lead?.leadId, '|', lead?.enquiryTitle);


    // Phase 2: Contact Buyer Now button click ENABLED
    contactButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await delay(500);

    // SINGLE CLICK approach — mimic human behavior exactly.
    // IndiaMart's "Contact Buyer Now" is an <a> tag with both an href AND an onclick handler.
    // The onclick handler runs IndiaMart's purchase JS (contactbuyernow function).
    // We need: onclick to fire (purchase) + NO page navigation.
    // Solution: event.preventDefault() stops browser navigation but lets onclick run.
    // IMPORTANT: Do NOT remove href — IndiaMart's JS reads it for parameters.
    // IMPORTANT: Do NOT use clickWithFallback — it clicks 4+ times causing double-purchase.
    const preventNav = (e: Event) => {
      e.preventDefault();
      console.log('[Content] Phase 2: Prevented <a> tag navigation via preventDefault');
    };

    if (contactButton.tagName === 'A') {
      contactButton.addEventListener('click', preventNav);
      console.log('[Content] Phase 2: Added preventDefault listener for <a> Contact Buyer button');
    }

    // Single click — exactly like a human would
    contactButton.click();
    console.log('[Content] Phase 2: Clicked Contact Buyer Now button (single click)');

    // Daily count is now incremented in processLeadsWithFiltering AFTER confirmed success,
    // not here. This ensures failed contacts don't waste daily quota slots.

    // Clean up the navigation prevention handler
    if (contactButton.tagName === 'A') {
      contactButton.removeEventListener('click', preventNav);
    }

    // Wait 10 seconds for the reply panel (bl_quote_form) to fully load with pre-filled message
    console.log('[Content] Phase 2: Waiting 10s for reply panel to load after Contact Buyer Now click...');
    await delay(10000);

    // Check for "already purchased" dialog first
    const alreadyPurchasedDialog = detectAlreadyPurchasedDialog();
    if (alreadyPurchasedDialog.detected) {

      // Dismiss the dialog by clicking OK — but DO NOT return early!
      // IndiaMart shows this dialog for NEWLY purchased leads too (as a confirmation).
      // We need to dismiss it and continue to the Send Reply step.
      const dismissed = await dismissAlreadyPurchasedDialog();
      if (dismissed) {
        console.log('[Content] Phase 2: Already purchased dialog dismissed — continuing to reply step');
      }

      // Wait 5 seconds for the reply panel to become accessible after dialog dismissal
      console.log('[Content] Phase 2: Waiting 5s after dialog dismissal for reply panel...');
      await delay(5000);
    }

    // Check for expired/consumed lead error modal
    const expiredModal = detectExpiredLeadModal();
    if (expiredModal.detected) {

      // Extract leadId and add to skip list
      if (lead?.leadId) {
        await addSkippedLead(lead.leadId);
      }

      // Store in rejected leads file with 'Lead Expired' reason
      if (lead) {
        await storeRejectedLead(lead, 'Lead Expired');
        console.log('[Content] Phase 2: Expired lead stored in rejected leads:', lead.leadId);
      }

      // Dismiss the modal
      const dismissed = await dismissExpiredLeadModal();
      if (dismissed) {
        console.log('[Content] Phase 2: Expired lead modal dismissed');
      }

      // Return early with specific error
      return {
        success: false,
        error: 'Lead expired or already consumed by maximum permissible sellers. Lead has been added to skip list.'
      };
    }

    // COMMENTED OUT: Using IndiaMart's default pre-filled message instead of custom message
    // const desiredMessage = composeContactMessage(lead);
    // let messageFilled = fillContactMessage(desiredMessage);
    // if (messageFilled) {
    //   console.log('[Content] Phase 2: Message filled successfully');
    // }

    const replyButton = await waitForElement(() => {
      // COMMENTED OUT: No longer trying to fill custom message
      // if (!messageFilled) {
      //   messageFilled = fillContactMessage(desiredMessage);
      //   if (messageFilled) {
      //     console.log('[Content] Phase 2: Message filled on retry');
      //   }
      // }

      const contexts = getInteractionContexts();
      for (const ctx of contexts) {
        for (const selector of SEND_REPLY_BUTTON_SELECTORS) {
          const candidate = ctx.querySelector<HTMLElement>(selector);
          if (isElementVisible(candidate)) {
            return candidate;
          }
        }
      }

      const fallbackButton = findSendReplyButton();
      if (isElementVisible(fallbackButton)) {
        return fallbackButton;
      }

      return null;
    }, 20000);

    if (shouldAbort()) {
      return { success: false, error: 'Auto-contact disabled.' };
    }

    if (!replyButton) {
      return { success: false, error: 'Send Reply button not found after opening contact form.' };
    }

    // COMMENTED OUT: No longer overriding IndiaMart's default message
    // if (!messageFilled) {
    //   messageFilled = fillContactMessage(desiredMessage);
    //   if (!messageFilled) {
    //     console.log('[Content] Phase 2: Warning - message could not be filled');
    //   }
    // }
    console.log('[Content] Phase 2: Using IndiaMart default message (no custom override)');

    // Phase 2: Send Reply button click ENABLED
    replyButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await delay(500); // Wait for scroll

    if (shouldAbort()) {
      return { success: false, error: 'Auto-contact disabled.' };
    }

    await clickWithFallback(replyButton, 'Send Reply');

    // Wait 10 seconds for IndiaMart's confirmation/processing panel to complete the reply submission
    console.log('[Content] Phase 2: Waiting 10s for Send Reply confirmation panel to process...');
    await delay(10000);

    // Phase 2: Check for "already purchased" dialog AFTER Reply click
    // This is the critical check — the dialog often appears only after Reply is clicked
    const postReplyAlreadyPurchased = detectAlreadyPurchasedDialog();
    if (postReplyAlreadyPurchased.detected) {
      console.log('[Content] Phase 2: "Already purchased" dialog detected AFTER Reply click');
      const dismissed = await dismissAlreadyPurchasedDialog();
      if (dismissed) {
        console.log('[Content] Phase 2: Already purchased dialog dismissed');
      }
      if (lead?.leadId) {
        await addSkippedLead(lead.leadId);
        console.log('[Content] Phase 2: Lead added to skip list:', lead.leadId);
      }
      return {
        success: false,
        error: 'Already purchased - detected after Reply click. Lead not counted toward daily quota.'
      };
    }

    let sendConfirmed = await waitForSendReplyConfirmation(6000);

    if (shouldAbort()) {
      return { success: false, error: 'Auto-contact disabled.' };
    }

    if (!sendConfirmed) {
      // Check if button is still visible - if not, it might have been clicked successfully
      const buttonStillVisible = isSendReplyButtonVisible();
      const messageFieldStillVisible = !!getVisibleMessageField();

      // If both button and message field are gone, check for "already purchased" before assuming success
      if (!buttonStillVisible && !messageFieldStillVisible) {
        // Phase 2: One more check — dialog may have caused UI elements to disappear
        const lateAlreadyPurchased = detectAlreadyPurchasedDialog();
        if (lateAlreadyPurchased.detected) {
          console.log('[Content] Phase 2: "Already purchased" dialog caused form to disappear');
          const dismissed = await dismissAlreadyPurchasedDialog();
          if (dismissed) {
            console.log('[Content] Phase 2: Late already-purchased dialog dismissed');
          }
          if (lead?.leadId) {
            await addSkippedLead(lead.leadId);
          }
          return {
            success: false,
            error: 'Already purchased - detected after form disappeared. Lead not counted toward daily quota.'
          };
        }
        // Do NOT assume success just because form disappeared.
        // Form may have collapsed without actually sending. Require positive confirmation.
        console.log('[Content] Phase 2: Form disappeared without positive success indicator — treating as inconclusive');
        sendConfirmed = false;
      } else {
        // Additional check: see if success indicators are present (they might have appeared quickly)
        await delay(1000); // Wait a bit more for potential success indicators
        sendConfirmed = await waitForSendReplyConfirmation(2000);

        if (!sendConfirmed && buttonStillVisible) {
          const retryButton =
            (replyButton.isConnected && isElementVisible(replyButton)) ?
              replyButton :
              await waitForElement(() => {
                const candidate = findSendReplyButton();
                return isElementVisible(candidate) ? candidate : null;
              }, 2000);

          if (retryButton && isSendReplyButtonVisible() && getVisibleMessageField()) {
            if (shouldAbort()) {
              return { success: false, error: 'Auto-contact disabled.' };
            }

            await clickWithFallback(retryButton, 'Send Reply Retry');
            await delay(1500);
            sendConfirmed = await waitForSendReplyConfirmation(6000);
          } else {
            // Button/field disappeared without positive confirmation — do not assume success
            console.log('[Content] Phase 2: Reply button disappeared without confirmation — treating as inconclusive');
            sendConfirmed = false;
          }
        }
      }
    }

    if (shouldAbort()) {
      return { success: false, error: 'Auto-contact disabled.' };
    }

    if (!sendConfirmed) {
      const messageContent = getMessageFieldContent();
      const validationError = getSendReplyError();
      return { success: false, error: validationError || 'Send Reply confirmation not detected.' };
    }

    // Contact successful - update history
    const leadDetails = lead || (card ? extractLead(card, cardIndex) : undefined);
    if (leadDetails && leadDetails.leadId) {
      contactedLeadHistory.set(leadDetails.leadId, Date.now());
      purgeStaleContactHistory();
    }

    console.log('[Content] Phase 2: Contact flow completed successfully for lead:', lead?.leadId);
    return { success: true };
  };

  // Removed duplicate startScrapeLoop - defined later in the file

  // Filter arrays — loaded ONLY from chrome.storage (set via extension UI).
  // NO hardcoded defaults. If user hasn't configured filters, arrays stay empty and all leads are rejected.
  let enquiryKeywords: string[] = [];
  let allowedCategories: string[] = [];
  let quantityThreshold = { min: 0, unit: 'piece' };
  let orderValueMin = 0;
  interface DailyContactStats {
    date: string;
    count: number;
    limit: number;
    dayOfWeek: number;
  }
  let dailyContactStats: DailyContactStats | null = null;
  let contactedLeadHistory: Map<string, number> = new Map();

  // Validation and date utilities imported from utils/

  const determineDailyLimit = (_dayOfWeek: number): number => {
    // Phase 2: Max 10 contacts per day
    return 10;
  };

  const initializeDailyStats = (): DailyContactStats => {
    const { dateKey, dayOfWeek } = getTodayIdentifier();
    const stats: DailyContactStats = {
      date: dateKey,
      dayOfWeek,
      count: 0,
      limit: determineDailyLimit(dayOfWeek),
    };
    dailyContactStats = stats;
    return stats;
  };

  const saveDailyContactStats = async (stats: DailyContactStats): Promise<void> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return;
    }
    await chrome.storage.local.set({ [DAILY_CONTACT_STATS_KEY]: stats });
    chrome.runtime?.sendMessage?.({ type: 'DAILY_CONTACT_STATS', payload: stats });
  };

  const loadDailyContactStats = async (): Promise<void> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      dailyContactStats = initializeDailyStats();
      return;
    }

    try {
      const stored = await chrome.storage.local.get([DAILY_CONTACT_STATS_KEY]);
      const stats = stored[DAILY_CONTACT_STATS_KEY] as DailyContactStats | undefined;
      const { dateKey } = getTodayIdentifier();

      if (!stats || stats.date !== dateKey) {
        const fresh = initializeDailyStats();
        await saveDailyContactStats(fresh);
      } else {
        dailyContactStats = stats;
      }
    } catch (error) {
      const fresh = initializeDailyStats();
      await saveDailyContactStats(fresh);
    }
  };

  const canContactMoreToday = (): boolean => {
    if (!dailyContactStats) {
      dailyContactStats = initializeDailyStats();
    }
    if (!dailyContactStats) {
      return true;
    }
    if (Date.now() < backoffUntil) {
      return false;
    }
    return dailyContactStats.count < dailyContactStats.limit;
  };

  const incrementDailyContactCount = async (): Promise<void> => {
    if (!dailyContactStats) {
      dailyContactStats = initializeDailyStats();
    }
    const { dateKey } = getTodayIdentifier();
    if (dailyContactStats && dailyContactStats.date !== dateKey) {
      dailyContactStats = initializeDailyStats();
    }
    if (!dailyContactStats) {
      return;
    }
    dailyContactStats.count += 1;
    await saveDailyContactStats(dailyContactStats);
  };

  const notifyDailyLimitReached = () => {
    if (!dailyContactStats) return;
    chrome.runtime?.sendMessage?.({ type: 'DAILY_CONTACT_LIMIT_REACHED', payload: dailyContactStats });
  };

  // CONTACT_HISTORY_RETENTION_MS imported from constants/timing

  const purgeStaleContactHistory = () => {
    const cutoff = Date.now() - CONTACT_HISTORY_RETENTION_MS;
    for (const [leadId, timestamp] of contactedLeadHistory.entries()) {
      if (timestamp < cutoff) {
        contactedLeadHistory.delete(leadId);
      }
    }
  };

  const loadContactHistory = async (): Promise<void> => {
    // Contact history is now only tracked in-memory
    contactedLeadHistory = new Map();
  };

  const wasLeadContactedRecently = (leadId?: string): boolean => {
    if (!leadId) return false;
    const timestamp = contactedLeadHistory.get(leadId);
    if (!timestamp) return false;
    return Date.now() - timestamp <= CONTACT_HISTORY_RETENTION_MS;
  };

  // Load filter keywords and categories from storage
  const loadFilterConfig = async (): Promise<void> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return;
    }

    try {
      const result = await chrome.storage.local.get([
        FILTER_KEYWORDS_KEY,
        FILTER_CATEGORIES_KEY,
        FILTER_QUANTITY_KEY,
        FILTER_ORDER_VALUE_KEY
      ]);

      // Load keywords from storage ONLY — no hardcoded defaults
      if (result[FILTER_KEYWORDS_KEY] !== undefined && Array.isArray(result[FILTER_KEYWORDS_KEY])) {
        enquiryKeywords = result[FILTER_KEYWORDS_KEY]
          .filter((k: string) => typeof k === 'string' && validateKeyword(k))
          .map((k: string) => k.trim())
          .slice(0, 500);
      } else {
        // No keywords in storage — keep empty. User must configure via extension UI.
        enquiryKeywords = [];
      }

      // Load categories from storage ONLY — no hardcoded defaults
      if (result[FILTER_CATEGORIES_KEY] !== undefined && Array.isArray(result[FILTER_CATEGORIES_KEY])) {
        allowedCategories = result[FILTER_CATEGORIES_KEY]
          .filter((c: string) => typeof c === 'string' && validateKeyword(c))
          .map((c: string) => c.trim())
          .slice(0, 500);
      } else {
        // No categories in storage — keep empty. User must configure via extension UI.
        allowedCategories = [];
      }

      // Load quantity threshold from storage ONLY
      if (result[FILTER_QUANTITY_KEY] !== undefined) {
        const stored = result[FILTER_QUANTITY_KEY];
        if (stored && typeof stored === 'object' && typeof stored.min === 'number' && typeof stored.unit === 'string') {
          quantityThreshold = {
            min: Math.max(1, Math.min(stored.min, 1000000)),
            unit: (stored.unit || 'piece').trim().toLowerCase()
          };
        } else {
          quantityThreshold = { min: 0, unit: 'piece' };
        }
      } else {
        // Not configured — min 0 means all quantities pass (user must set via UI)
        quantityThreshold = { min: 0, unit: 'piece' };
      }

      // Load order value minimum from storage ONLY
      if (result[FILTER_ORDER_VALUE_KEY] !== undefined) {
        const stored = result[FILTER_ORDER_VALUE_KEY];
        if (typeof stored === 'number' && stored >= 0 && stored <= 100000000) {
          orderValueMin = stored;
        } else {
          orderValueMin = 0;
        }
      } else {
        // Not configured — 0 means all order values pass (user must set via UI)
        orderValueMin = 0;
      }

      // Log loaded filter config for debugging
      console.log('[Content] ====== FILTER CONFIG LOADED ======');
      console.log('[Content] Keywords:', enquiryKeywords.length, '→', JSON.stringify(enquiryKeywords));
      console.log('[Content] Categories:', allowedCategories.length, '→', JSON.stringify(allowedCategories));
      console.log('[Content] Quantity threshold:', quantityThreshold.min, quantityThreshold.unit);
      console.log('[Content] Order value min:', orderValueMin);
      if (enquiryKeywords.length === 0) {
        console.warn('[Content] ⚠️ NO KEYWORDS CONFIGURED — all leads will be REJECTED until keywords are set in extension settings');
      }
      console.log('[Content] ============================');

      // Mark config as loaded
      filterConfigLoaded = true;

      // Notify popup that config has been loaded (if popup is open)
      if (chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'FILTER_CONFIG_LOADED',
          config: {
            keywords: enquiryKeywords,
            categories: allowedCategories,
            quantity: quantityThreshold,
            orderValueMin: orderValueMin
          }
        }).catch(() => {
          // Ignore errors if popup is not open
        });
      }
    } catch (error) {
      // On error — keep arrays empty. No hardcoded defaults.
      // User must configure filters via extension UI.
      enquiryKeywords = [];
      allowedCategories = [];
      quantityThreshold = { min: 0, unit: 'piece' };
      orderValueMin = 0;
      filterConfigLoaded = true;
    }
  };

  // Save filter keywords and categories to storage
  const saveFilterConfig = async (
    keywords?: string[],
    categories?: string[],
    quantity?: { min: number; unit: string },
    orderValue?: number
  ): Promise<boolean> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return false;
    }

    try {
      const toSave: Record<string, any> = {};

      if (keywords) {
        const validated = keywords
          .filter(validateKeyword)
          .map(k => k.trim())
          .slice(0, 500);
        toSave[FILTER_KEYWORDS_KEY] = validated;
        enquiryKeywords = validated;
      }

      if (categories) {
        const validated = categories
          .filter(validateKeyword)
          .map(c => c.trim())
          .slice(0, 500);
        toSave[FILTER_CATEGORIES_KEY] = validated;
        allowedCategories = validated;
      }

      // Save quantity threshold
      if (quantity !== undefined) {
        const validated = {
          min: Math.max(1, Math.min(quantity.min, 1000000)), // Validate range 1-1M
          unit: (quantity.unit || 'piece').trim().toLowerCase()
        };
        toSave[FILTER_QUANTITY_KEY] = validated;
        quantityThreshold = validated;
      }

      // Save order value minimum
      if (orderValue !== undefined) {
        const validated = Math.max(0, Math.min(orderValue, 100000000)); // Validate range 0-100M
        toSave[FILTER_ORDER_VALUE_KEY] = validated;
        orderValueMin = validated;
      }

      if (Object.keys(toSave).length > 0) {
        await chrome.storage.local.set(toSave);
        return true;
      }

      return false;
    } catch (error) {
      return false;
    }
  };

  const getFilterCriteria = () => ({
    keywords: enquiryKeywords,
    indianStates: INDIAN_STATES,
    quantity: quantityThreshold,
    orderValueMin,
    categories: allowedCategories,
  });

  const applyIntelligentFilter = (lead: Lead): { passed: boolean; reason: string; nextContactDelayMinutes: number } => {
    // Wait for filter config to load if not ready
    if (!filterConfigLoaded) {
      return { passed: false, reason: 'Filter config not loaded', nextContactDelayMinutes: 0 };
    }

    // Filters come ONLY from extension UI (chrome.storage). No hardcoded defaults.

    // Filter 1: Enquiry Title Keywords — MANDATORY
    // If no keywords configured, reject ALL leads (user must set keywords via UI)
    if (enquiryKeywords.length === 0) {
      return { passed: false, reason: 'No keywords configured — set keywords in extension settings', nextContactDelayMinutes: 0 };
    }

    const titleLower = (lead.enquiryTitle || lead.requirement || '').toLowerCase();
    const matchedKeyword = enquiryKeywords.find(keyword => titleLower.includes(keyword.toLowerCase()));
    if (!matchedKeyword) {
      return { passed: false, reason: 'No matching keywords found in title', nextContactDelayMinutes: 0 };
    }
    console.log(`[Content] Filter Matched Keyword: "${matchedKeyword}" for title: "${lead.enquiryTitle}"`);

    // Filter 2: State validation - check if state is in Indian states list
    const location = lead.location || '';

    if (!location || location === 'N/A') {
    } else {
      // Extract state from location (format: "City, State" or just "State")
      // Split by comma and get the last part (state)
      const locationParts = location.split(',').map(part => part.trim());
      const state = locationParts[locationParts.length - 1]; // Get last part (state)

      // Check if state matches any Indian state (case-insensitive)
      const stateLower = state.toLowerCase();
      const isValidIndianState = INDIAN_STATES.some(indianState =>
        stateLower === indianState.toLowerCase()
      );

      if (!isValidIndianState) {
        return { passed: false, reason: `State "${state}" not in Indian states list`, nextContactDelayMinutes: 0 };
      }
    }

    // Filter 3: Quantity ≥ threshold (flexible - check number first, unit match optional)
    // First check: quantity number must meet threshold
    const quantityMeetsThreshold = typeof lead.quantity === 'number' && lead.quantity >= quantityThreshold.min;

    // DEBUG LOG for strict filtering verification
    console.log(`[Content] Filter Check: Lead ${lead.leadId.substring(0, 8)}... Quantity: ${lead.quantity} (raw: "${lead.quantityRaw || 'N/A'}") vs Min: ${quantityThreshold.min}. Result: ${quantityMeetsThreshold ? 'PASS' : 'FAIL'}`);

    if (!quantityMeetsThreshold) {
      return {
        passed: false,
        reason: `Quantity must be ≥ ${quantityThreshold.min} ${quantityThreshold.unit.charAt(0).toUpperCase()}${quantityThreshold.unit.slice(1)}`,
        nextContactDelayMinutes: 0
      };
    }

    // Second check: if quantityRaw is available, verify it includes the expected unit (optional check)
    // This is a soft check - if quantityRaw doesn't exist or doesn't match unit, still pass if quantity number is valid
    if (typeof lead.quantityRaw === 'string' && lead.quantityRaw.trim()) {
      const quantityRawLower = lead.quantityRaw.toLowerCase();
      const hasUnitMatch = quantityRawLower.includes(quantityThreshold.unit.toLowerCase());
      // Only warn if unit doesn't match, but don't fail the filter
      if (!hasUnitMatch) {
      }
    }

    // Filter 4: Category match — only check if categories are configured AND lead has a category
    if (allowedCategories.length > 0 && lead.category) {
      const categoryLower = (lead.category || '').toLowerCase();

      const hasCategory = allowedCategories.some((keyword) => {
        const normalized = keyword.toLowerCase();
        return categoryLower.includes(normalized) || normalized.includes(categoryLower);
      });

      if (!hasCategory) {
        return { passed: false, reason: 'Category not in allowed list', nextContactDelayMinutes: 0 };
      }
    }
    // If categories not configured, skip category check (keywords filter is the primary gate)

    // Filter 5: Probable Order Value ≥ threshold (use max value for ranges like "₹3,000 to ₹10,000")
    // Only check when: (a) user has set a threshold > 0, AND (b) the scraper actually found an order value.
    // If the scraper couldn't extract the order value, we skip this check rather than assuming 0
    // and incorrectly rejecting the lead.
    if (orderValueMin > 0) {
      const orderValue = lead.probableOrderValueMax ?? lead.probableOrderValueMin;
      if (orderValue !== undefined && orderValue < orderValueMin) {
        return { passed: false, reason: `Order value < ₹${orderValueMin.toLocaleString()}`, nextContactDelayMinutes: 0 };
      }
    }

    // Generate random delay between 1-10 minutes for qualified leads
    const delayOptions = [1, 5, 10];
    const randomDelay = delayOptions[Math.floor(Math.random() * delayOptions.length)];

    return { passed: true, reason: 'Meets all criteria', nextContactDelayMinutes: randomDelay };
  };

  const selectLeadsForCycle = (leads: Lead[]): Lead[] => {
    if (!leads.length) return [];
    // Select all filtered leads, sorted by order value (highest first)
    const scored = leads
      .map((lead) => {
        const value = lead.probableOrderValueMax ?? lead.probableOrderValueMin ?? 0;
        return { lead, value };
      })
      .sort((a, b) => b.value - a.value);

    // Return all leads, sorted by order value
    return scored.map(item => item.lead);
  };

  const scheduleProcessingCycle = (immediate = false) => {
    if (processingTimer) {
      clearTimeout(processingTimer);
      processingTimer = null;
    }
    if (isStopped || !isAutoContactEnabled) {
      return;
    }

    const delayMs = immediate ? randomBetween(3000, 8000) : getStealthDelayMs();
    lastScheduledProcessingWindow = `${(delayMs / 60000).toFixed(2)}m`;

    processingTimer = setTimeout(async () => {
      processingTimer = null;
      if (!isStopped && isAutoContactEnabled) {
        try {
          await processLeadsWithFiltering();
        } catch (error) {
          registerAutomationError((error as Error)?.message || 'Processing cycle failed');
        }
      }
      scheduleProcessingCycle();
    }, delayMs);
  };

  // Setup periodic processing with stealth scheduling
  const setupPeriodicProcessing = () => {
    if (isStopped || !isAutoContactEnabled) {
      return;
    }
    scheduleProcessingCycle(true);
  };

  const scheduleRefreshCycle = () => {
    if (pageRefreshTimer) {
      clearTimeout(pageRefreshTimer);
      pageRefreshTimer = null;
    }
    if (isStopped || !isAutoContactEnabled) {
      return;
    }

    const delayMs = getStealthDelayMs();
    lastScheduledRefreshWindow = `${(delayMs / 1000).toFixed(0)}s`;

    pageRefreshTimer = setTimeout(() => {
      if (!isStopped && isAutoContactEnabled) {
        lastRefreshTime = Date.now();
        window.location.reload();
      }
    }, delayMs);
  };

  // Setup automatic refresh using stealth schedule
  const setupPeriodicRefresh = () => {
    if (isStopped || !isAutoContactEnabled) {
      return;
    }
    scheduleRefreshCycle();
  };


  interface LeadEvaluation {
    lead: Lead;
    passed: boolean;
    reason: string;
  }


  const formatOrderValueRange = (lead: Lead): string | undefined => {
    if (lead.probableOrderValueRaw) return lead.probableOrderValueRaw;
    const { probableOrderValueMin: min, probableOrderValueMax: max } = lead;
    if (typeof min === 'number' && typeof max === 'number') {
      if (min === max) return `₹${min.toLocaleString()}`;
      return `₹${min.toLocaleString()} – ₹${max.toLocaleString()}`;
    }
    if (typeof min === 'number') return `₹${min.toLocaleString()}+`;
    if (typeof max === 'number') return `Up to ₹${max.toLocaleString()}`;
    return undefined;
  };



  const processLeadsWithFiltering = async () => {
    // Acquire execution lock FIRST — before any await or checks.
    // This prevents race conditions from visibilitychange or ENABLE_AUTO_CONTACT
    // firing a second call while the first is awaiting loadDailyContactStats.
    if (isLeadProcessingRunning) {
      return;
    }
    isLeadProcessingRunning = true;

    if (!isAutoContactEnabled || isStopped) {
      lastProcessingTime = Date.now();
      isLeadProcessingRunning = false;
      return;
    }

    if (!filterConfigLoaded) {
      console.log('[Content] Filter config not loaded yet, skipping processing cycle');
      lastProcessingTime = Date.now();
      isLeadProcessingRunning = false;
      return;
    }

    if (!dailyContactStats) {
      await loadDailyContactStats();
    }

    lastProcessingTime = Date.now();

    try {
      // Cancel page refresh timer during processing to prevent mid-contact-flow reloads
      if (pageRefreshTimer) {
        clearTimeout(pageRefreshTimer);
        pageRefreshTimer = null;
      }

      if (lastRefreshTime > 0 && Date.now() - lastRefreshTime < 8000) {
        const waitMs = randomBetween(3000, 8000);
        await delay(waitMs);
      }

      // Scroll until "Show More Suggested Leads" button is visible (don't click it)
      await ensureMinimumLeadCards(MIN_LEAD_TARGET);

      // Process ALL leads available on the page (not limited to 50)
      const leads = scrapeLeads();
      const skipIndexes = pickRandomSkipIndexes(leads.length);
      const filteredLeads: Lead[] = [];
      const leadEvaluations: LeadEvaluation[] = [];
      const cycleErrors: string[] = [];
      const cycleActions: string[] = [];
      const cycleTimestamp = new Date().toISOString();
      filteredLeadsCount = 0;
      contactedLeadsCount = 0;
      pendingContacts = [];

      console.log('[Content] ===== PROCESSING CYCLE START =====');
      console.log('[Content] Total leads scraped:', leads.length);
      console.log('[Content] Random skip indexes:', Array.from(skipIndexes));
      console.log('[Content] Already processed leads:', processedLeads.size);
      console.log('[Content] Filter keywords:', enquiryKeywords.length, '→', JSON.stringify(enquiryKeywords));
      console.log('[Content] filterConfigLoaded:', filterConfigLoaded);
      let skippedAlreadyProcessed = 0, skippedRandom = 0, skippedRecent = 0, skippedExpired = 0, filterPassed = 0, filterFailed = 0, contactAttempted = 0, contactSucceeded = 0, contactFailed = 0;


      for (const [index, lead] of leads.entries()) {
        // Check if auto-contact was disabled during processing
        if (!isAutoContactEnabled || isStopped) {
          break;
        }

        if (processedLeads.has(lead.leadId)) {
          skippedAlreadyProcessed++;
          continue;
        }

        if (skipIndexes.has(index)) {
          skippedRandom++;
          leadEvaluations.push({
            lead,
            passed: false,
            reason: 'Skipped for human-like browsing cadence',
          });
          continue;
        }

        await applyReadingDelay(lead);

        // Check again after delay
        if (!isAutoContactEnabled || isStopped) {
          break;
        }

        if (wasLeadContactedRecently(lead.leadId)) {
          skippedRecent++;
          leadEvaluations.push({
            lead,
            passed: false,
            reason: 'Contacted within last 10 days (duplicate guard)',
          });
          continue;
        }

        if (isLeadSkipped(lead.leadId)) {
          skippedExpired++;
          leadEvaluations.push({
            lead,
            passed: false,
            reason: 'Lead expired/consumed previously (skip list)',
          });
          continue;
        }

        // Enhanced logging for debugging

        const filterResult = applyIntelligentFilter(lead);
        // Track filter results separately — do NOT mutate the lead object itself,
        // as it gets stored in the rejected/passed leads log and should be clean.
        const passedFilter = filterResult.passed;
        const filterReason = filterResult.reason;
        const nextContactDelayMinutes = filterResult.nextContactDelayMinutes;
        leadEvaluations.push({ lead, passed: passedFilter, reason: filterReason });

        if (!passedFilter) {
          filterFailed++;
          console.log('[Content] FILTER REJECTED:', lead.leadId, '|', lead.enquiryTitle?.substring(0, 30), '| Reason:', filterReason);
        }

        if (passedFilter) {
          filterPassed++;
          // Add to filtered leads array for statistics/logging
          filteredLeads.push(lead);
          filteredLeadsCount = filteredLeads.length;

          // Contact lead if daily limit not yet reached
          if (canContactMoreToday()) {
            console.log('[Content] Daily limit not reached, attempting contact for:', lead.leadId, lead.companyName);

            console.log('[Content] FILTER GATE PASSED — contacting lead:', lead.leadId, '| Keyword match:', passedFilter, '| Qty:', lead.quantity, '| OrderValue:', lead.probableOrderValueMax ?? lead.probableOrderValueMin);

            let contactResult: { success: boolean; error?: string };
            contactAttempted++;
            try {
              contactResult = await performContactFlow(lead.cardIndex ?? index, lead);
            } catch (error) {
              contactResult = { success: false, error: `Contact flow crashed: ${error}` };
              console.error('[Content] performContactFlow threw an error:', error);
            }

            if (contactResult.success) {
              // Only on confirmed success: increment daily count and store as CONTACTED
              await incrementDailyContactCount();
              await storePassedLead(lead, filterReason, 'CONTACTED');
              contactedLeadsCount++;
              contactSucceeded++;
              cycleActions.push(`CONTACTED: ${lead.companyName || lead.leadId}`);
              console.log('[Content] Contact successful for lead:', lead.leadId, '| Daily count:', dailyContactStats?.count, '/', dailyContactStats?.limit);
            } else {
              // Contact failed — do NOT store in passed file, just skip
              contactFailed++;
              console.log('[Content] Contact FAILED for:', lead.leadId, '| Error:', contactResult.error);
            }
          } else {
            // Daily limit reached — store lead but do NOT contact/buy
            console.log('[Content] Daily limit reached, storing lead without contact:', lead.leadId);
            await storePassedLead(lead, filterReason, 'STORED');
          }

          // Mark as processed so we don't process again
          processedLeads.add(lead.leadId);

          // Small delay between processing leads
          await delay(randomBetween(500, 1500));
        } else {
          // ========== SCRAPE-ONLY MODE: Store rejected lead with reason ==========
          await storeRejectedLead(lead, filterReason);
          processedLeads.add(lead.leadId);
          // ========== END SCRAPE-ONLY MODE ==========
        }
      }

      // ===== DIAGNOSTIC SUMMARY =====
      console.log('[Content] ===== PROCESSING CYCLE SUMMARY =====');
      console.log('[Content] Total scraped:', leads.length);
      console.log('[Content] Skipped (already processed):', skippedAlreadyProcessed);
      console.log('[Content] Skipped (random cadence):', skippedRandom);
      console.log('[Content] Skipped (recently contacted):', skippedRecent);
      console.log('[Content] Skipped (expired/consumed):', skippedExpired);
      console.log('[Content] Filter PASSED:', filterPassed);
      console.log('[Content] Filter REJECTED:', filterFailed);
      console.log('[Content] Contact attempted:', contactAttempted);
      console.log('[Content] Contact SUCCEEDED:', contactSucceeded);
      console.log('[Content] Contact FAILED:', contactFailed);
      console.log('[Content] ======================================');

      // Update final counts for statistics
      filteredLeadsCount = filteredLeads.length;
      pendingContacts = [...filteredLeads];

      // Persist filtered leads to cache storage after filtering completes
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          'indiamart_filtered_leads_cache': filteredLeads,
        });
      }

      const buyLeadBalance = getBuyLeadBalanceEstimate();
      const cycleSummary = {
        timestamp: cycleTimestamp,
        totalLeads: leads.length,
        qualifiedLeads: filteredLeads.length,
        selectedLeads: filteredLeads.map((lead) => ({
          id: lead.leadId,
          company: lead.companyName,
          orderValue: formatOrderValueRange(lead) || 'N/A',
        })),
        skippedLeads: skipIndexes.size,
        dailyStats: dailyContactStats,
        buyLeadBalance,
        actions: cycleActions,
        errors: cycleErrors,
        backoffActive: Date.now() < backoffUntil,
      };

      chrome.runtime.sendMessage({
        type: 'FILTERED_LEADS_DATA',
        payload: {
          allLeads: leads,
          filteredLeads,
          autoContactEnabled: isAutoContactEnabled,
          filters: getFilterCriteria(),
          cycleSummary,
        },
      });


      // Check if all leads are filtered out or no leads remain to contact
      // If so, refresh immediately instead of waiting 30 seconds
      const noLeadsPassedFilters = filteredLeads.length === 0;
      const allFilteredLeadsContacted = filteredLeads.length > 0 && contactedLeadsCount >= filteredLeads.length;

      // Check if there are any remaining leads that could be contacted
      // (leads that passed filters but haven't been contacted yet)
      const remainingContactableLeads = filteredLeads.filter(lead => {
        return !processedLeads.has(lead.leadId) &&
          !wasLeadContactedRecently(lead.leadId) &&
          !isLeadSkipped(lead.leadId);
      }).length;

      const noLeadsRemainToContact = remainingContactableLeads === 0;

      if ((noLeadsPassedFilters || allFilteredLeadsContacted || noLeadsRemainToContact) &&
        isAutoContactEnabled &&
        !isStopped) {
        // Clear the periodic refresh timer since we're refreshing now
        if (pageRefreshTimer) {
          clearTimeout(pageRefreshTimer);
          pageRefreshTimer = null;
        }

        // Refresh immediately (Wait 2 minutes before reloading)
        lastRefreshTime = Date.now();
        console.log('[Content] Cycle complete. Waiting 2 minutes before reload...');
        await delay(120000);
        window.location.reload();
        return; // Exit early since page will reload
      }
    } finally {
      isLeadProcessingRunning = false;
    }
  };

  // Handle tab visibility changes - Enhanced visibility detection
  let lastVisibilityChangeTime = Date.now();
  let tabWentInactiveTime = 0;

  document.addEventListener('visibilitychange', () => {
    const wasVisible = isTabVisible;
    isTabVisible = !document.hidden;

    if (!isTabVisible && wasVisible) {
      // Tab became inactive
      tabWentInactiveTime = Date.now();
    }

    if (isTabVisible && !wasVisible) {
      // Tab became visible again
      if (isAutoContactEnabled && !isStopped) {
        // Process leads immediately when tab becomes visible
        setTimeout(() => {
          processLeadsWithFiltering();
        }, 1000); // Small delay to ensure page is fully loaded
      }

      tabWentInactiveTime = 0; // Reset
    }

    lastProcessingTime = Date.now();
    lastVisibilityChangeTime = Date.now();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.log('[Content] Message received:', message?.type, message);

    if (!message || typeof message !== 'object') {
      console.log('[Content] Invalid message, ignoring');
      return;
    }

    if (message.type === 'SCRAPE_NOW') {
      console.log('[Content] SCRAPE_NOW - Starting ensureMinimumLeadCards...');
      ensureMinimumLeadCards(MIN_LEAD_TARGET)
        .catch((error) => {
          console.error('[Content] Auto-scroll failed before SCRAPE_NOW:', error);
        })
        .finally(() => {
          const leads = scrapeLeads();
          console.log('[Content] SCRAPE_NOW - Scraped leads count:', leads.length);
          sendResponse({ leads });
        });
      return true;
    }

    if (message.type === 'CONTACT_LEAD') {
      console.log('[Content] CONTACT_LEAD - cardIndex:', message.cardIndex);
      const { cardIndex, lead: leadPayload } = message;
      performContactFlow(cardIndex, leadPayload)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err?.message || 'Unknown error during contact flow.' }));
      return true;
    }

    if (message.type === 'REFRESH_PAGE') {
      console.log('[Content] REFRESH_PAGE - Reloading page');
      window.location.reload();
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'ENABLE_AUTO_CONTACT') {
      console.log('[Content] ENABLE_AUTO_CONTACT - Starting automation...');
      isStopped = false;
      isAutoContactEnabled = true;
      stopAutomationTimers();
      console.log('[Content] Starting scrape loop...');
      startScrapeLoop();
      console.log('[Content] Setting up periodic processing...');
      setupPeriodicProcessing(); // Set up periodic processing for logs
      setupPeriodicRefresh(); // Set up periodic refresh
      console.log('[Content] Processing leads with filtering...');
      processLeadsWithFiltering();
      zeroBalanceDetected = false;
      startZeroBalanceObserver();
      console.log('[Content] ENABLE_AUTO_CONTACT - Complete');
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'DISABLE_AUTO_CONTACT') {
      console.log('[Content] DISABLE_AUTO_CONTACT - Stopping automation');
      resetAutomationState({ stopped: false });
      isLeadProcessingRunning = false; // Force stop any ongoing processing
      contactInFlight = false; // Cancel any in-flight contacts
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'STOP_AGENT') {
      console.log('[Content] STOP_AGENT - Force stopping all');

      // Force stop all flags immediately
      isStopped = true;
      isAutoContactEnabled = false;
      isLeadProcessingRunning = false;
      contactInFlight = false;

      // Reset all automation state (stops timers, observers, etc.)
      resetAutomationState({ stopped: true });

      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'SCRAPE_AND_FILTER') {
      console.log('[Content] SCRAPE_AND_FILTER');
      processLeadsWithFiltering();
      sendResponse({ success: true });
      return true;
    }


    if (message.type === 'FILTER_KEYWORDS_UPDATED') {
      console.log('[Content] FILTER_KEYWORDS_UPDATED - Reloading filter config');
      // Reload filter config from storage and re-run filtering if active
      loadFilterConfig()
        .then(() => {

          // Notify popup of updated criteria
          chrome.runtime.sendMessage({ type: 'FILTER_CRITERIA_UPDATE', payload: getFilterCriteria() });

          // Re-run filtering if auto-contact is enabled
          if (isAutoContactEnabled && !isStopped) {
            processLeadsWithFiltering();
          }
        })
        .catch((error) => {
          console.error('[Content] Error loading filter config:', error);
        });
      sendResponse({ success: true });
      return true;
    }

    // ========== SCRAPE-ONLY MODE: Message handlers for passed leads log ==========
    if (message.type === 'GET_PASSED_LEADS_LOG') {
      console.log('[Content] GET_PASSED_LEADS_LOG');
      chrome.storage.local.get(STORAGE_KEYS.PASSED_LEADS_LOG, (result) => {
        const logs = result[STORAGE_KEYS.PASSED_LEADS_LOG] || [];
        sendResponse({ success: true, logs });
      });
      return true;
    }

    if (message.type === 'GET_PASSED_LEADS_COUNT') {
      console.log('[Content] GET_PASSED_LEADS_COUNT');
      chrome.storage.local.get(STORAGE_KEYS.PASSED_LEADS_LOG, (result) => {
        const logs = result[STORAGE_KEYS.PASSED_LEADS_LOG] || [];
        sendResponse({ success: true, count: logs.length });
      });
      return true;
    }

    if (message.type === 'CLEAR_PASSED_LEADS_LOG') {
      console.log('[Content] CLEAR_PASSED_LEADS_LOG');
      chrome.storage.local.remove(STORAGE_KEYS.PASSED_LEADS_LOG, () => {
        sendResponse({ success: true });
      });
      return true;
    }

    // ========== REJECTED LEADS LOG HANDLERS ==========
    if (message.type === 'GET_REJECTED_LEADS_LOG') {
      console.log('[Content] GET_REJECTED_LEADS_LOG');
      chrome.storage.local.get(STORAGE_KEYS.REJECTED_LEADS_LOG, (result) => {
        const logs = result[STORAGE_KEYS.REJECTED_LEADS_LOG] || [];
        sendResponse({ success: true, logs });
      });
      return true;
    }

    if (message.type === 'GET_REJECTED_LEADS_COUNT') {
      console.log('[Content] GET_REJECTED_LEADS_COUNT');
      chrome.storage.local.get(STORAGE_KEYS.REJECTED_LEADS_LOG, (result) => {
        const logs = result[STORAGE_KEYS.REJECTED_LEADS_LOG] || [];
        sendResponse({ success: true, count: logs.length });
      });
      return true;
    }

    if (message.type === 'CLEAR_REJECTED_LEADS_LOG') {
      console.log('[Content] CLEAR_REJECTED_LEADS_LOG');
      chrome.storage.local.remove(STORAGE_KEYS.REJECTED_LEADS_LOG, () => {
        sendResponse({ success: true });
      });
      return true;
    }
    // ========== END SCRAPE-ONLY MODE ==========
  });

  // Initial scraping
  const startScrapeLoop = () => {
    console.log('[Content] startScrapeLoop called. initialScrapeInterval:', !!initialScrapeInterval, 'isStopped:', isStopped, 'isAutoContactEnabled:', isAutoContactEnabled);

    if (initialScrapeInterval || isStopped || !isAutoContactEnabled) {
      console.log('[Content] startScrapeLoop - Early exit, conditions not met');
      return;
    }

    console.log('[Content] startScrapeLoop - Starting interval...');
    let attempts = 0;
    initialScrapeInterval = setInterval(() => {
      if (!isAutoContactEnabled || isStopped) {
        console.log('[Content] startScrapeLoop - Auto-contact disabled or stopped, clearing timers');
        stopAutomationTimers();
        return;
      }

      attempts += 1;
      console.log('[Content] startScrapeLoop - Attempt', attempts, ', calling ensureMinimumLeadCards...');
      ensureMinimumLeadCards(MIN_LEAD_TARGET)
        .catch((error) => {
          console.error('[Content] Auto-scroll failed during initial scrape:', error);
        })
        .finally(() => {
          const leads = scrapeLeads();
          console.log('[Content] startScrapeLoop - Scraped leads:', leads.length);
          if (leads.length > 0) {
            console.log('[Content] startScrapeLoop - Leads found, clearing interval and sending data');
            if (initialScrapeInterval) {
              clearInterval(initialScrapeInterval);
              initialScrapeInterval = null;
            }
            chrome.runtime.sendMessage({ type: 'LEADS_DATA', payload: leads });
            chrome.runtime.sendMessage({ type: 'FILTER_CRITERIA_UPDATE', payload: getFilterCriteria() });
            // Also run filtering
            processLeadsWithFiltering();
          } else if (attempts >= SCRAPE_MAX_ATTEMPTS) {
            console.log('[Content] startScrapeLoop - Max attempts reached, no leads found');
            if (initialScrapeInterval) {
              clearInterval(initialScrapeInterval);
              initialScrapeInterval = null;
            }
            chrome.runtime.sendMessage({
              type: 'SCRAPING_ERROR',
              error: 'Could not find any leads on the page. Please ensure they are visible.',
            });
          }
        });
    }, SCRAPE_INTERVAL_MS);
    console.log('[Content] startScrapeLoop - Interval started');
  };

  // ========== IDLE POPUP AUTO-CLICK HANDLER ==========
  // IndiaMART shows a popup "You've been inactive for a while!" with "Get Fresh Leads" button
  // Button HTML: <button id="Yes" class="send_quo ys_quo w_1" onclick="getFreshLeads();">Get Fresh Leads</button>
  // This auto-clicks that button to prevent the extension from getting stuck

  const clickGetFreshLeadsButton = (): boolean => {
    // Try multiple selectors to find the button
    const selectors = [
      'button#Yes',                          // By ID
      '#Yes',                                // Just ID
      'button.send_quo.ys_quo',              // By classes
      '.send_quo.ys_quo',                    // Just classes
      'button[onclick*="getFreshLeads"]',    // By onclick attribute
      '.sm_inn_pop_n button',                // Button inside popup container
      '.act_btns button'                     // Button inside action buttons div
    ];

    for (const selector of selectors) {
      const button = document.querySelector(selector) as HTMLElement;
      if (button && button.textContent?.includes('Fresh Leads')) {
        console.log(`[Content] IDLE POPUP: Found button with selector "${selector}" - CLICKING NOW`);

        // Method 1: Direct click
        try {
          button.click();
          console.log('[Content] IDLE POPUP: Click method 1 (direct click) executed');
        } catch (e) {
          console.error('[Content] IDLE POPUP: Direct click failed:', e);
        }

        // Method 2: Dispatch native click event
        try {
          const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
          });
          button.dispatchEvent(clickEvent);
          console.log('[Content] IDLE POPUP: Click method 2 (dispatchEvent) executed');
        } catch (e) {
          console.error('[Content] IDLE POPUP: dispatchEvent failed:', e);
        }

        // Method 3: Focus and enter key
        try {
          button.focus();
          const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true });
          button.dispatchEvent(enterEvent);
          console.log('[Content] IDLE POPUP: Click method 3 (focus+enter) executed');
        } catch (e) {
          console.error('[Content] IDLE POPUP: focus+enter failed:', e);
        }

        // Method 4: Call onclick directly
        try {
          const btn = button as HTMLButtonElement;
          if (btn.onclick) {
            btn.onclick.call(btn, new PointerEvent('click'));
            console.log('[Content] IDLE POPUP: Click method 4 (onclick) executed');
          }
        } catch (e) {
          console.error('[Content] IDLE POPUP: onclick failed:', e);
        }

        // Method 5: Try to call window.getFreshLeads() directly
        try {
          if (typeof (window as any).getFreshLeads === 'function') {
            (window as any).getFreshLeads();
            console.log('[Content] IDLE POPUP: Click method 5 (window.getFreshLeads) executed');
          }
        } catch (e) {
          console.error('[Content] IDLE POPUP: window.getFreshLeads failed:', e);
        }

        return true;
      }
    }

    return false;
  };

  // Use a separate variable so it's never stopped by stopAutomationTimers
  let _idlePopupInterval: ReturnType<typeof setInterval> | null = null;

  const startIdlePopupWatcher = () => {
    // Clear any existing interval
    if (_idlePopupInterval) {
      clearInterval(_idlePopupInterval);
    }

    console.log('[Content] IDLE POPUP WATCHER: Starting (will check every 2 seconds)');

    // Check every 2 seconds for the "Get Fresh Leads" button
    _idlePopupInterval = setInterval(() => {
      // Log every check to verify it's running
      const found = clickGetFreshLeadsButton();
      if (found) {
        console.log('[Content] IDLE POPUP WATCHER: Button was found and clicked!');
      }
    }, 2000); // 2 seconds - very aggressive

    // Do an immediate check
    clickGetFreshLeadsButton();
  };

  const stopIdlePopupWatcher = () => {
    if (_idlePopupInterval) {
      clearInterval(_idlePopupInterval);
      _idlePopupInterval = null;
      console.log('[Content] IDLE POPUP WATCHER: Stopped');
    }
  };
  // ========== END IDLE POPUP AUTO-CLICK HANDLER ==========

  // Listen for storage changes to reload filter config automatically
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        const filterKeys = [
          FILTER_KEYWORDS_KEY,
          FILTER_CATEGORIES_KEY,
          FILTER_QUANTITY_KEY,
          FILTER_ORDER_VALUE_KEY
        ];
        const hasFilterChange = filterKeys.some(key => changes[key]);
        if (hasFilterChange) {
          loadFilterConfig().catch((error) => {
          });
        }
      }
    });
  }

  // Initialize: Load filter config and skipped leads from storage, then start observers
  void Promise.all([loadFilterConfig(), loadSkippedLeads(), loadDailyContactStats(), loadContactHistory()])
    .then(() => {
      startZeroBalanceObserver();
      startIdlePopupWatcher(); // Start watching for idle popup
      syncAutoContactState();
    })
    .catch((error) => {
      startZeroBalanceObserver();
      startIdlePopupWatcher(); // Start watching for idle popup even on error
      syncAutoContactState();
    });
})(); // End of IIFE
