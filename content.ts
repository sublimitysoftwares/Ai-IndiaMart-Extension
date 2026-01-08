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
  // Check if already loaded
  if ((window as any)[GLOBAL_FLAG]) {
    return;
  }
  
  // Mark as loaded
  (window as any)[GLOBAL_FLAG] = true;
  
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

  const syncAutoContactState = () => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      return;
    }

    chrome.runtime.sendMessage({ type: 'GET_AGENT_STATUS' }, (response) => {
      if (chrome.runtime.lastError) {
        return;
      }

      if (response && response.success) {
        const previousState = isAutoContactEnabled;
        isAutoContactEnabled = Boolean(response.autoContactEnabled);
        isStopped = Boolean(response.agentStopped);

        if (isAutoContactEnabled && !isStopped) {
          if (!previousState) {
          }
          startScrapeLoop();
          setupPeriodicProcessing();
          setupPeriodicRefresh();
        } else {
          resetAutomationState({ stopped: isStopped });
        }
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
          return true;
        }
      }
    }

    if (!isSendReplyButtonVisible() && !getVisibleMessageField()) {
      return true;
    }

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

    // Look for modal/alert elements
    const modalSelectors = [
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
    const contexts = getLeadSearchContexts();
    const seen = new Set<HTMLElement>();
    const cards: HTMLElement[] = [];

    contexts.forEach((ctx, ctxIndex) => {
      const contextLabel = describeContext(ctx, ctxIndex);
      LEAD_CARD_SELECTORS.forEach((selector) => {
        const matches = Array.from(ctx.querySelectorAll<HTMLElement>(selector));
        matches.forEach((match) => {
          if (!seen.has(match)) {
            seen.add(match);
            cards.push(match);
          }
        });
        if (matches.length > 0) {
        }
      });
    });

    if (cards.length === 0) {
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
    const existing = getLeadCardElements().length;
    
    // Check if "Show More Suggested Leads" button is already visible
    const showMoreBtnCheck = findShowMoreButton();
    if (showMoreBtnCheck && isElementVisible(showMoreBtnCheck)) {
      const btnText = (showMoreBtnCheck.textContent || '').trim();
      // Check if it's the "Show More Suggested Leads" button (not "SHOW MORE BUYLEADS")
      if (btnText.includes('Show More Suggested Leads')) {
        // Scroll to it to ensure it's fully in view, then stop
        showMoreBtnCheck.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await delay(1000);
        return;
      }
    }

    const now = Date.now();
    // Remove cooldown restriction - allow continuous scrolling
    if (existing >= minCount && now - lastAutoScrollRun < AUTO_SCROLL_COOLDOWN_MS) {
      return;
    }
    lastAutoScrollRun = now;


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

    const orderValueNode = card.querySelector('li[title="Probable Order Value"], .bl-order-value, .probable-order');
    const orderValueText = getTableValue(card as HTMLElement, 'Probable Order Value') || orderValueNode?.textContent || card.textContent?.match(/Probable Order Value\s*[:\-]?\s*([^\n]+)/i)?.[1];
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
    const cards = getLeadCardElements();
    const leads = cards.map((card, index) => extractLead(card, index));
    return leads;
  };

  // findElementByText and waitForElement imported from utils/dom

  const performContactFlow = async (cardIndex: number, lead?: Lead): Promise<{ success: boolean; error?: string }> => {
    const shouldAbort = () => isStopped || !isAutoContactEnabled;
    if (shouldAbort()) {
      return { success: false, error: 'Auto-contact disabled.' };
    }

    
    // Get cards and find the right card
    const cards = getLeadCardElements();
    
    let card = cards[cardIndex];
    
    // If card not found by index, try to find by matching lead data
    if (!card && lead) {
      for (let i = 0; i < cards.length; i++) {
        const testCard = cards[i];
        const cardText = (testCard.textContent || '').toLowerCase();
        const enquiryTitleLower = (lead.enquiryTitle || '').toLowerCase();
        const companyNameLower = (lead.companyName || '').toLowerCase();
        
        // Match by enquiry title or company name
        if ((enquiryTitleLower && cardText.includes(enquiryTitleLower)) ||
            (companyNameLower && cardText.includes(companyNameLower))) {
          card = testCard;
          break;
        }
      }
    }
    
    // Detect if we're on a detail page (no cards found or card not available)
    const isDetailPage = !card || cards.length === 0;
    
    if (isDetailPage) {
    }

    // Scroll card into view if it exists, otherwise scroll to top
    if (card && card instanceof HTMLElement) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(1000); // Wait for scroll to complete
    } else if (isDetailPage) {
      // On detail pages, scroll to top to ensure button visibility
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await delay(1000);
    } else {
    }

    // Enhanced button search: try multiple strategies with better logging
    const contactButton = await waitForElement(() => {
      // Strategy 1: Try finding button in card (if card exists)
      if (card) {
        const button = findElementByText(card, 'button, a', CONTACT_BUTTON_TEXT);
        if (isElementVisible(button)) {
          return button;
        }
        const located = locateContactButton(card, false);
        if (isElementVisible(located)) {
          return located;
        }
      }
      
      // Strategy 2: Document-wide search (especially for detail pages)
      const docButton = findElementByText(document, 'button, a', CONTACT_BUTTON_TEXT);
      if (isElementVisible(docButton)) {
        return docButton;
      }
      
      // Strategy 3: Use enhanced locateContactButton with document search
      const locatedDoc = locateContactButton(card, true);
      if (isElementVisible(locatedDoc)) {
        return locatedDoc;
      }
      
      // Strategy 4: Flexible text search in document
      const allButtons = document.querySelectorAll<HTMLElement>('button, a, [role="button"]');
      for (const btn of allButtons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        if ((text.includes('contact buyer') || ariaLabel.includes('contact buyer')) && isElementVisible(btn)) {
          return btn;
        }
      }
      
      return null;
    }, 15000); // Increased timeout to 15 seconds for better reliability

    if (shouldAbort()) {
      return { success: false, error: 'Auto-contact disabled.' };
    }

    if (!contactButton) {
      return { success: false, error: 'Contact Buyer Now button not found.' };
    }

    
    // COMMENTED OUT: Contact Buyer Now button click flow
    // // Ensure button is visible and in viewport before clicking
    // contactButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // await delay(500);
    // 
    // await clickWithFallback(contactButton, 'Contact Buyer');

    // Return early since contact button click is disabled
    return { success: false, error: 'Contact Buyer Now button click is currently disabled.' };

    // COMMENTED OUT: All code below is disabled since contact button click is commented out
    /* 
    // Wait for contact form/modal to appear after clicking Contact Buyer Now
    await delay(1000); // Additional delay for form to load

    // Check for "already purchased" dialog first
    const alreadyPurchasedDialog = detectAlreadyPurchasedDialog();
    if (alreadyPurchasedDialog.detected) {
      
      // Dismiss the dialog by clicking OK
      const dismissed = await dismissAlreadyPurchasedDialog();
      if (dismissed) {
      } else {
      }

      // Add to skip list since this lead is already purchased
      if (lead?.leadId) {
        await addSkippedLead(lead.leadId);
      }

      // Return early with specific error
      return { 
        success: false, 
        error: 'This Buy Lead has already been purchased. Lead has been added to skip list.' 
      };
    }

    // Check for expired/consumed lead error modal
    const expiredModal = detectExpiredLeadModal();
    if (expiredModal.detected) {
      
      // Extract leadId and add to skip list
      if (lead?.leadId) {
        await addSkippedLead(lead.leadId);
      } else {
      }

      // Dismiss the modal
      const dismissed = await dismissExpiredLeadModal();
      if (dismissed) {
      } else {
      }

      // Return early with specific error
      return { 
        success: false, 
        error: 'Lead expired or already consumed by maximum permissible sellers. Lead has been added to skip list.' 
      };
    }

    // Attempt to fill the message while the form loads
    const desiredMessage = composeContactMessage(lead);
    let messageFilled = fillContactMessage(desiredMessage);
    if (messageFilled) {
    }

    const replyButton = await waitForElement(() => {
      if (!messageFilled) {
        messageFilled = fillContactMessage(desiredMessage);
        if (messageFilled) {
        }
      }

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
    

    if (!messageFilled) {
      // Try one last time before sending
      messageFilled = fillContactMessage(desiredMessage);
      if (!messageFilled) {
      }
    }

    // COMMENTED OUT: Send Reply button click flow
    // // Ensure button is in view before clicking
    // replyButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // await delay(500); // Wait for scroll

    // if (shouldAbort()) {
    //   return { success: false, error: 'Auto-contact disabled.' };
    // }

    // await clickWithFallback(replyButton, 'Send Reply');

    // // Give the site a moment to register the submission
    // await delay(1200);

    // let sendConfirmed = await waitForSendReplyConfirmation(6000);

    // if (shouldAbort()) {
    //   return { success: false, error: 'Auto-contact disabled.' };
    // }

    // if (!sendConfirmed) {
    //   // Check if button is still visible - if not, it might have been clicked successfully
    //   const buttonStillVisible = isSendReplyButtonVisible();
    //   const messageFieldStillVisible = !!getVisibleMessageField();
    //   
    //   // If both button and message field are gone, the form might have been submitted
    //   if (!buttonStillVisible && !messageFieldStillVisible) {
    //     sendConfirmed = true;
    //   } else {
    //     
    //     // Additional check: see if success indicators are present (they might have appeared quickly)
    //     await delay(1000); // Wait a bit more for potential success indicators
    //     sendConfirmed = await waitForSendReplyConfirmation(2000);
    //     
    //     if (!sendConfirmed && buttonStillVisible) {
    //       const retryButton =
    //         (replyButton.isConnected && isElementVisible(replyButton)) ?
    //           replyButton :
    //           await waitForElement(() => {
    //             const candidate = findSendReplyButton();
    //             return isElementVisible(candidate) ? candidate : null;
    //           }, 2000);

    //       if (retryButton && isSendReplyButtonVisible() && getVisibleMessageField()) {
    //         if (shouldAbort()) {
    //           return { success: false, error: 'Auto-contact disabled.' };
    //         }

    //         await clickWithFallback(retryButton, 'Send Reply Retry');
    //         await delay(1500);
    //         sendConfirmed = await waitForSendReplyConfirmation(6000);
    //       } else {
    //         // If button disappeared, assume it was sent
    //         if (!isSendReplyButtonVisible() && !getVisibleMessageField()) {
    //           sendConfirmed = true;
    //         }
    //       }
    //     }
    //   }
    // }

    // if (shouldAbort()) {
    //   return { success: false, error: 'Auto-contact disabled.' };
    // }

    // if (!sendConfirmed) {
    //   const messageContent = getMessageFieldContent();
    //   const validationError = getSendReplyError();
    //   return { success: false, error: validationError || 'Send Reply confirmation not detected.' };
    // }

    // Return early since we're not actually clicking the buttons
    return { success: false, error: 'Contact and Send Reply button clicks are currently disabled.' };

    // COMMENTED OUT: Code below would execute after successful send reply
    const leadDetails = lead || (card ? extractLead(card, cardIndex) : undefined);
    if (leadDetails && leadDetails.leadId) {
      contactedLeadHistory.set(leadDetails.leadId, Date.now());
      purgeStaleContactHistory();
    }

    return { success: true };
    */
  };

  // Removed duplicate startScrapeLoop - defined later in the file

  // Filter constants imported from constants/filters
  // Mutable filter arrays (loaded from storage on init)
  let enquiryKeywords: string[] = [...DEFAULT_ENQUIRY_KEYWORDS];
  let allowedCategories: string[] = [...DEFAULT_ALLOWED_CATEGORIES];
  let quantityThreshold = { min: 20, unit: 'piece' };
  let orderValueMin = 5000;
  interface DailyContactStats {
    date: string;
    count: number;
    limit: number;
    dayOfWeek: number;
  }
  let dailyContactStats: DailyContactStats | null = null;
  let contactedLeadHistory: Map<string, number> = new Map();

  // Validation and date utilities imported from utils/

  const determineDailyLimit = (dayOfWeek: number): number => {
    // Sunday (0) => 6-8, Monday-Saturday => 14-18
    return dayOfWeek === 0 ? randomIntBetween(6, 8) : randomIntBetween(14, 18);
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
      
      // Load keywords: update if key exists in storage (even if empty array)
      if (result[FILTER_KEYWORDS_KEY] !== undefined) {
        if (Array.isArray(result[FILTER_KEYWORDS_KEY])) {
          const storedKeywords = result[FILTER_KEYWORDS_KEY]
            .filter((k: string) => typeof k === 'string' && validateKeyword(k))
            .map((k: string) => k.trim())
            .slice(0, 500); // Limit to 500 items
          enquiryKeywords = storedKeywords;
        } else {
          enquiryKeywords = [...DEFAULT_ENQUIRY_KEYWORDS];
        }
      } else {
        // Key doesn't exist in storage, use defaults and save them
        enquiryKeywords = [...DEFAULT_ENQUIRY_KEYWORDS];
        // Save defaults to storage for first-time initialization
        await chrome.storage.local.set({ [FILTER_KEYWORDS_KEY]: DEFAULT_ENQUIRY_KEYWORDS });
      }

      // Load categories: update if key exists in storage (even if empty array)
      if (result[FILTER_CATEGORIES_KEY] !== undefined) {
        if (Array.isArray(result[FILTER_CATEGORIES_KEY])) {
          const storedCategories = result[FILTER_CATEGORIES_KEY]
            .filter((c: string) => typeof c === 'string' && validateKeyword(c))
            .map((c: string) => c.trim())
            .slice(0, 500); // Limit to 500 items
          allowedCategories = storedCategories;
        } else {
          allowedCategories = [...DEFAULT_ALLOWED_CATEGORIES];
          await chrome.storage.local.set({ [FILTER_CATEGORIES_KEY]: DEFAULT_ALLOWED_CATEGORIES });
        }
      } else {
        // Key doesn't exist in storage, use defaults and save them
        allowedCategories = [...DEFAULT_ALLOWED_CATEGORIES];
        // Save defaults to storage for first-time initialization
        await chrome.storage.local.set({ [FILTER_CATEGORIES_KEY]: DEFAULT_ALLOWED_CATEGORIES });
      }

      // Load quantity threshold: update if key exists in storage
      if (result[FILTER_QUANTITY_KEY] !== undefined) {
        const stored = result[FILTER_QUANTITY_KEY];
        if (stored && typeof stored === 'object' && typeof stored.min === 'number' && typeof stored.unit === 'string') {
          quantityThreshold = {
            min: Math.max(1, Math.min(stored.min, 1000000)), // Validate range 1-1M
            unit: (stored.unit || 'piece').trim().toLowerCase()
          };
        } else {
          quantityThreshold = { min: 20, unit: 'piece' };
          await chrome.storage.local.set({ [FILTER_QUANTITY_KEY]: quantityThreshold });
        }
      } else {
        quantityThreshold = { min: 20, unit: 'piece' };
        // Save defaults to storage for first-time initialization
        await chrome.storage.local.set({ [FILTER_QUANTITY_KEY]: quantityThreshold });
      }

      // Load order value minimum: update if key exists in storage
      if (result[FILTER_ORDER_VALUE_KEY] !== undefined) {
        const stored = result[FILTER_ORDER_VALUE_KEY];
        if (typeof stored === 'number' && stored >= 0 && stored <= 100000000) { // Validate range 0-100M
          orderValueMin = stored;
        } else {
          orderValueMin = 5000;
          await chrome.storage.local.set({ [FILTER_ORDER_VALUE_KEY]: orderValueMin });
        }
      } else {
        orderValueMin = 5000;
        // Save defaults to storage for first-time initialization
        await chrome.storage.local.set({ [FILTER_ORDER_VALUE_KEY]: orderValueMin });
      }

      // Verify arrays are actually updated

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
      // Fallback to defaults on error
      enquiryKeywords = [...DEFAULT_ENQUIRY_KEYWORDS];
      allowedCategories = [...DEFAULT_ALLOWED_CATEGORIES];
      filterConfigLoaded = true; // Mark as loaded even on error (using defaults)
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


    // Note: We're using the runtime arrays (enquiryKeywords, allowedCategories) which are updated from storage
    // These arrays are NOT the hardcoded DEFAULT arrays - they're mutable variables that get updated

    // Filter 1: Enquiry Title Keywords (universal uniform check + keyword list)
    const titleLower = (lead.enquiryTitle || lead.requirement || '').toLowerCase();
    
    // Primary check: Universal uniform keywords (passes immediately if found)
    const uniformPatterns = [
      /\buniform\b/,
      /\buniforms\b/,
      /\buniform\s+fabric\b/,
      /\buniform\s+fabrics\b/,
      /\buniform-fabric\b/,
      /\buniform_fabric\b/
    ];
    const hasUniformKeyword = uniformPatterns.some(pattern => pattern.test(titleLower));
    
    // Fallback check: Keyword list (only if uniform not found)
    const hasKeyword = hasUniformKeyword || enquiryKeywords.some(keyword => titleLower.includes(keyword));
    
    if (!hasKeyword) {
      return { passed: false, reason: 'No uniform keywords found', nextContactDelayMinutes: 0 };
    }
    
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
    
    // Special handling: If title contains "coat", use lower quantity threshold (10 pieces)
    const hasCoatKeyword = titleLower.includes('coat');
    const effectiveQuantityThreshold = hasCoatKeyword ? 10 : quantityThreshold.min;
    
    if (hasCoatKeyword) {
    }
    
    // First check: quantity number must meet threshold
    const quantityMeetsThreshold = typeof lead.quantity === 'number' && lead.quantity >= effectiveQuantityThreshold;
    
    if (!quantityMeetsThreshold) {
      return {
        passed: false,
        reason: `Quantity must be ≥ ${effectiveQuantityThreshold} ${quantityThreshold.unit.charAt(0).toUpperCase()}${quantityThreshold.unit.slice(1)}`,
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
    
    // Filter 4: Category match
    const categoryLower = (lead.category || '').toLowerCase();
    
    // First check: automatically pass if category contains "uniform" or "uniform fabric"
    const uniformKeywords = ['uniform', 'uniform fabric', 'uniforms', 'uniform-fabric', 'uniform_fabric'];
    const categoryHasUniform = uniformKeywords.some(keyword => categoryLower.includes(keyword));
    
    // Second check: fall back to allowedCategories list if no uniform keyword found
    const hasCategory = categoryHasUniform || allowedCategories.some((keyword) => {
      const normalized = keyword.toLowerCase();
      return categoryLower.includes(normalized) || normalized.includes(categoryLower);
    });
    
    // Only fail if category exists but doesn't match either condition
    if (!hasCategory && lead.category) {
      return { passed: false, reason: 'Category not in allowed list', nextContactDelayMinutes: 0 };
    }
    if (!lead.category) {
    } else {
    }
    
    // Filter 5: Probable Order Value ≥ ₹10,000
    const orderValue = lead.probableOrderValueMin || lead.probableOrderValueMax || 0;
    if (orderValue < orderValueMin) {
      return { passed: false, reason: `Order value < ₹${orderValueMin.toLocaleString()}`, nextContactDelayMinutes: 0 };
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

  const processFilteredLead = async (lead: Lead, cardIndex: number): Promise<boolean> => {
    if (!isAutoContactEnabled || isStopped) {
      return false;
    }
    
    // Check if this lead was already processed/contacted to prevent duplicates
    if (processedLeads.has(lead.leadId)) {
      return false;
    }
    
    if (wasLeadContactedRecently(lead.leadId)) {
      return false;
    }
    
    return withContactLock(async () => {
      // Double-check after acquiring lock (another thread might have processed it)
      if (processedLeads.has(lead.leadId)) {
        return false;
      }
      
      // Mark as processing immediately to prevent concurrent attempts
      processedLeads.add(lead.leadId);
      
      // Check again after acquiring lock
      if (!isAutoContactEnabled || isStopped) {
        processedLeads.delete(lead.leadId); // Remove from processed since we didn't actually contact
        return false;
      }
      
      try {
        const result = await performContactFlow(cardIndex, lead);
        
        // Check again after contact flow completes
        if (!isAutoContactEnabled || isStopped) {
          if (!result.success) {
            processedLeads.delete(lead.leadId); // Remove if contact failed
          }
          return false;
        }
        
        if (result.success) {
          // Lead is already in processedLeads (added before contact attempt)
          lastContactTime = Date.now();
          contactedLeadsCount++;
          
          // Persist leads to cache storage (filtered leads will be persisted separately when filtering completes)
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            const leads = scrapeLeads();
            chrome.storage.local.set({
              'indiamart_leads_cache': leads,
            });
          }
          
          chrome.runtime.sendMessage({
            type: 'AUTO_CONTACT_SUCCESS',
            leadId: lead.leadId,
            companyName: lead.companyName,
            timestamp: new Date().toISOString(),
            contactedCount: contactedLeadsCount,
            totalFiltered: filteredLeadsCount,
            tabHidden: document.hidden
          });
          
          
          // Note: Refresh check is handled after all leads are processed in processLeadsWithFiltering
          // This ensures we check once after processing all leads, not multiple times during processing
          
          return true;
        } else {
          // Contact failed, remove from processedLeads so it can be retried later
          processedLeads.delete(lead.leadId);
          if (result.error) {
            registerAutomationError(result.error);
          }
        }
      } catch (error) {
        // Contact failed due to exception, remove from processedLeads
        processedLeads.delete(lead.leadId);
        registerAutomationError((error as Error)?.message || 'Unknown contact flow error');
      }
      
      return false;
    });
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
    if (!isAutoContactEnabled || isStopped) {
      lastProcessingTime = Date.now();
      return;
    }

    if (!filterConfigLoaded) {
      lastProcessingTime = Date.now();
      return;
    }

    if (isLeadProcessingRunning) {
      lastProcessingTime = Date.now();
      return;
    }

    if (!dailyContactStats) {
      await loadDailyContactStats();
    }

    isLeadProcessingRunning = true;
    lastProcessingTime = Date.now();

    try {
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


      for (const [index, lead] of leads.entries()) {
        // Check if auto-contact was disabled during processing
        if (!isAutoContactEnabled || isStopped) {
          break;
        }
        
        if (processedLeads.has(lead.leadId)) {
          continue;
        }

        if (skipIndexes.has(index)) {
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
          leadEvaluations.push({
            lead,
            passed: false,
            reason: 'Contacted within last 10 days (duplicate guard)',
          });
          continue;
        }

        if (isLeadSkipped(lead.leadId)) {
          leadEvaluations.push({
            lead,
            passed: false,
            reason: 'Lead expired/consumed previously (skip list)',
          });
          continue;
        }

        // Enhanced logging for debugging

        const filterResult = applyIntelligentFilter(lead);
        lead.passedFilter = filterResult.passed;
        lead.filterReason = filterResult.reason;
        lead.nextContactDelayMinutes = filterResult.nextContactDelayMinutes;
        leadEvaluations.push({ lead, passed: filterResult.passed, reason: filterResult.reason });


        if (filterResult.passed) {
          // Add to filtered leads array for statistics/logging
          filteredLeads.push(lead);
          filteredLeadsCount = filteredLeads.length;

          // Immediately process this lead if auto-contact is enabled and quota allows
          if (isAutoContactEnabled && !isStopped && canContactMoreToday()) {
            // Double-check that lead hasn't been processed/contacted already
            if (processedLeads.has(lead.leadId)) {
              continue;
            }
            if (wasLeadContactedRecently(lead.leadId)) {
              continue;
            }
            
            
            const contacted = await processFilteredLead(lead, lead.cardIndex || 0);
            if (contacted) {
              await incrementDailyContactCount();
              // Note: contactedLeadHistory is already set in performContactFlow
              // Note: contactedLeadsCount is already incremented in processFilteredLead, so we don't increment it here
              purgeStaleContactHistory();
              clearAutomationErrors();
              cycleActions.push(`Contacted ${lead.companyName || lead.leadId}`);
              // contactedLeadsCount is incremented in processFilteredLead, no need to increment here
              
              // Add delay before processing next lead
              if (typeof lead.nextContactDelayMinutes === 'number' && lead.nextContactDelayMinutes > 0) {
                await delay(lead.nextContactDelayMinutes * 60 * 1000);
              } else {
                await delay(randomBetween(1000, 3000));
              }
            } else {
              const errMsg = `Failed to contact ${lead.companyName || lead.leadId}`;
              cycleErrors.push(errMsg);
              registerAutomationError(errMsg);
            }

            // Check if daily quota reached after contact
            if (!canContactMoreToday()) {
              cycleActions.push('Daily quota met mid-cycle. Remaining leads deferred.');
              notifyDailyLimitReached();
              break; // Stop processing more leads
            }
          } else if (!canContactMoreToday()) {
            cycleActions.push('Daily quota reached. Skipping remaining leads.');
            notifyDailyLimitReached();
            break; // Stop processing more leads
          }
        }
      }

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
        
        // Refresh immediately
        lastRefreshTime = Date.now();
        await delay(1000);
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
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'SCRAPE_NOW') {
      ensureMinimumLeadCards(MIN_LEAD_TARGET)
        .catch((error) => {
          // Auto-scroll failed before SCRAPE_NOW
        })
        .finally(() => {
          sendResponse({ leads: scrapeLeads() });
        });
      return true;
    }

    if (message.type === 'CONTACT_LEAD') {
      const { cardIndex, lead: leadPayload } = message;
      performContactFlow(cardIndex, leadPayload)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err?.message || 'Unknown error during contact flow.' }));
      return true;
    }

    if (message.type === 'REFRESH_PAGE') {
      window.location.reload();
      sendResponse({ success: true });
      return true;
    }
    
    if (message.type === 'ENABLE_AUTO_CONTACT') {
      isStopped = false;
      isAutoContactEnabled = true;
      stopAutomationTimers();
      startScrapeLoop();
      setupPeriodicProcessing(); // Set up periodic processing for logs
      setupPeriodicRefresh(); // Set up periodic refresh
      processLeadsWithFiltering();
      zeroBalanceDetected = false;
      startZeroBalanceObserver();
      sendResponse({ success: true });
      return true;
    }
    
    if (message.type === 'DISABLE_AUTO_CONTACT') {
      resetAutomationState({ stopped: false });
      isLeadProcessingRunning = false; // Force stop any ongoing processing
      contactInFlight = false; // Cancel any in-flight contacts
      sendResponse({ success: true });
      return true;
    }
    
    if (message.type === 'STOP_AGENT') {
      
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
      processLeadsWithFiltering();
      sendResponse({ success: true });
      return true;
    }
    

    if (message.type === 'FILTER_KEYWORDS_UPDATED') {
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
        });
      sendResponse({ success: true });
      return true;
    }
  });

  // Initial scraping
  const startScrapeLoop = () => {
    if (initialScrapeInterval || isStopped || !isAutoContactEnabled) {
      return;
    }

    let attempts = 0;
    initialScrapeInterval = setInterval(() => {
      if (!isAutoContactEnabled || isStopped) {
        stopAutomationTimers();
        return;
      }

      attempts += 1;
      ensureMinimumLeadCards(MIN_LEAD_TARGET)
        .catch((error) => {
          // Auto-scroll failed during initial scrape
        })
        .finally(() => {
          const leads = scrapeLeads();
          if (leads.length > 0) {
            if (initialScrapeInterval) {
              clearInterval(initialScrapeInterval);
              initialScrapeInterval = null;
            }
            chrome.runtime.sendMessage({ type: 'LEADS_DATA', payload: leads });
            chrome.runtime.sendMessage({ type: 'FILTER_CRITERIA_UPDATE', payload: getFilterCriteria() });
            // Also run filtering
            processLeadsWithFiltering();
          } else if (attempts >= SCRAPE_MAX_ATTEMPTS) {
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
  };
  
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
      syncAutoContactState();
    })
    .catch((error) => {
      startZeroBalanceObserver();
      syncAutoContactState();
    });
})(); // End of IIFE
