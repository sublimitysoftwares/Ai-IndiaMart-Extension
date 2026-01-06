/// <reference types="chrome" />
import type { Lead } from './types';

// Wrap everything in an IIFE to prevent redeclaration errors
(() => {
  const GLOBAL_FLAG = '__INDIAMART_AGENT_CONTENT__';
  
  // Check if already loaded
  if ((window as any)[GLOBAL_FLAG]) {
    console.log('IndiaMART Agent: Content script already loaded, skipping...');
    return;
  }
  
  // Mark as loaded
  (window as any)[GLOBAL_FLAG] = true;
  console.log('IndiaMART Agent: Content script initializing...');

  const LEAD_CARD_SELECTORS = [
    'div.f1.lstNw',
    'div.lstNw.lstNwDflx',
    'div.lstNw.BUY_pr',
    'div.bl-itm',
    'div[class*="lead-card"]',
    'li[class*="lead-card"]',
    'div[data-card-type="lead"]',
    '[data-testid*="lead"]',
    '.lead-card',
    '.blk-txn-card',
  ];
  const CONTACT_BUTTON_TEXT = 'Contact Buyer Now';
  const SEND_REPLY_TEXT = 'Send Reply';
  const SEND_REPLY_SELECTOR = '.btn-latest';
  const SEND_REPLY_BUTTON_SELECTORS = [
    '.btnCBNContainer .btnCBN1',
    '.btnCBNContainer [onclick*="sendreply"]',
    '.btnCBNContainer button[data-action*="send"]',
    '.btnCBNContainer button[data-testid*="reply"]',
    '[data-action="send-reply"]',
    'button[id*="SendReply"]',
    'button[class*="sendReply"]',
    'button[aria-label*="send reply" i]',
    'button[aria-label*="send message" i]',
    '[role="button"][aria-label*="send reply" i]',
    '[role="button"][aria-label*="send message" i]',
    '.leadReplyBtn',
  ];
  const SCRAPE_INTERVAL_MS = 1000;
  const SCRAPE_MAX_ATTEMPTS = 15;
  const WORKING_HOURS = { start: 9, end: 21 }; // 9 AM – 9 PM
  const WORKING_REFRESH_RANGE_MINUTES = { min: 5, max: 15 };
  const OFF_HOURS_REFRESH_RANGE_MINUTES = { min: 65, max: 90 };
  const MIN_LEAD_TARGET = 50; // desired minimum number of leads before processing
  const AUTO_SCROLL_MAX_ATTEMPTS = 500; // Significantly increased to ensure reaching 50 leads
  const AUTO_SCROLL_DELAY_MS = 1000; // 1 second per lead scrolling speed (target: 50 leads)
  const AUTO_SCROLL_COOLDOWN_MS = 5 * 1000; // Reduced to 5 seconds to allow more frequent scrolling
  const DEFAULT_CONTACT_MESSAGE = `Hello,\n\nWe supply premium-quality uniforms and would love to support your requirement. Please let us know the sizes and timelines so we can share the best quote.\n\nThanks,\nTeam IndiaMART Agent`;
  const SKIPPED_LEADS_KEY = 'indiamart_skipped_leads'; // Storage key for skipped lead IDs
  
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
  const BACKOFF_ERROR_THRESHOLD = 3;
  const BACKOFF_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
  const BACKOFF_MIN_DELAY_MS = 5 * 60 * 1000;
  const BACKOFF_MAX_DELAY_MS = 10 * 60 * 1000;

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
      console.log('[IndiaMART Agent] Zero balance observer stopped');
    }
  };

  const resetAutomationState = ({ stopped = false }: { stopped?: boolean } = {}): void => {
    console.log('[IndiaMART Agent] 🛑 Resetting automation state - stopping all processes...');
    
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
    
    console.log('[IndiaMART Agent] ✅ All processes stopped and state reset');
  };

  const randomBetween = (min: number, max: number): number => Math.random() * (max - min) + min;
  const randomIntBetween = (min: number, max: number): number =>
    Math.floor(randomBetween(min, max + 1));

  const describeScheduleWindow = (isWorkingHours: boolean): string =>
    isWorkingHours ? '09:00-21:00' : '21:00-09:00';

  const getStealthDelayMs = (): number => {
    // Fixed 30 second refresh interval
    const delaySeconds = 30;
    console.log(
      `[IndiaMART Agent] Scheduling next refresh in ${delaySeconds} seconds.`
    );
    return delaySeconds * 1000; // 30 seconds in milliseconds
  };

  const registerAutomationError = (reason: string) => {
    const now = Date.now();
    recentErrors.push(now);
    while (recentErrors.length && now - recentErrors[0] > BACKOFF_WINDOW_MS) {
      recentErrors.shift();
    }
    console.warn(`[IndiaMART Agent] Logged automation error (${recentErrors.length}/${BACKOFF_ERROR_THRESHOLD}): ${reason}`);
    if (recentErrors.length >= BACKOFF_ERROR_THRESHOLD) {
      backoffUntil = now + randomBetween(BACKOFF_MIN_DELAY_MS, BACKOFF_MAX_DELAY_MS);
      recentErrors.length = 0;
      console.warn(
        `[IndiaMART Agent] Entering natural back-off until ${new Date(backoffUntil).toLocaleTimeString()}.`
      );
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
        console.warn('Sync auto-contact state failed:', chrome.runtime.lastError.message);
        return;
      }

      if (response && response.success) {
        const previousState = isAutoContactEnabled;
        isAutoContactEnabled = Boolean(response.autoContactEnabled);
        isStopped = Boolean(response.agentStopped);

        if (isAutoContactEnabled && !isStopped) {
          if (!previousState) {
            console.log('Auto-contact restored from background state. Setting up periodic refresh and processing.');
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

  const sanitize = (value?: string | null): string => (value || '').trim();
  const sanitizeOptional = (value?: string | null): string | undefined => {
    const cleaned = sanitize(value);
    return cleaned || undefined;
  };

  const getInteractionContexts = (): (Document | ShadowRoot)[] => {
    const contexts: (Document | ShadowRoot)[] = [document];
    const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'));
    iframes.forEach((frame) => {
      try {
        const doc = frame.contentDocument;
        if (doc) {
          contexts.push(doc);
        }
      } catch (error) {
        console.debug('[IndiaMART Agent] Skipping cross-origin iframe while collecting interaction contexts.');
      }
    });
    return contexts;
  };

  const simulateMouseMove = (element?: HTMLElement): void => {
    const rect = element?.getBoundingClientRect();
    const fallbackX = randomBetween(100, Math.max(120, window.innerWidth - 100));
    const fallbackY = randomBetween(120, Math.max(140, window.innerHeight - 120));
    const clientX = rect
      ? rect.left + randomBetween(rect.width * 0.2, rect.width * 0.8)
      : fallbackX;
    const clientY = rect
      ? rect.top + randomBetween(rect.height * 0.2, rect.height * 0.8)
      : fallbackY;
    const moveEvent = new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      movementX: randomBetween(-5, 5),
      movementY: randomBetween(-5, 5),
      view: window,
    });
    (element || document.body || document).dispatchEvent(moveEvent);
  };

  const simulateHoverDelay = async (element: HTMLElement): Promise<void> => {
    const passes = randomIntBetween(2, 4);
    for (let i = 0; i < passes; i++) {
      simulateMouseMove(element);
      await delay(randomBetween(80, 180));
    }
    await delay(randomBetween(400, 1200));
  };

  const simulatePostClickMovement = async (element?: HTMLElement): Promise<void> => {
    await delay(randomBetween(200, 600));
    simulateMouseMove(element);
    await delay(randomBetween(120, 300));
    simulateMouseMove();
  };

  const humanScrollBy = async (distance: number): Promise<void> => {
    window.scrollBy({ top: distance, behavior: 'auto' });
    simulateMouseMove();
    await delay(500); // Fixed 500ms delay for consistent 1 second per lead timing
  };

  const performHumanScrollPass = async (): Promise<void> => {
    // 1 second per lead scrolling - much larger distances to ensure reaching 50 leads
    const distance = randomBetween(700, 1000); // Much larger scroll distance to cover more ground efficiently
    await humanScrollBy(distance);
    await delay(500); // Fixed 500ms delay to maintain 1 second per lead
  };

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

  const isElementVisible = (element: HTMLElement | null | undefined): element is HTMLElement => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

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
        console.error('[AI Contact Bridge] Failed to execute click handler:', error);
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
    console.debug(`[IndiaMART Agent] Triggering ${label} action via robust click.`);
    try {
      await triggerRobustClick(element);
    } catch (error) {
      console.error(`[IndiaMART Agent] Robust click failed for ${label}:`, error);
    }

    if (!element.isConnected) return;
    await delay(randomBetween(150, 350));

    try {
      element.click();
      console.debug(`[IndiaMART Agent] Executed fallback click for ${label}.`);
    } catch (error) {
      console.warn(`[IndiaMART Agent] Fallback click failed for ${label}:`, error);
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

  const setElementValue = (element: HTMLElement, value: string): void => {
    if ((element as HTMLTextAreaElement).value !== undefined) {
      const control = element as HTMLTextAreaElement;
      if (control.value && control.value.trim()) return;
      control.focus();
      control.value = value;
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
    } else if ((element as HTMLInputElement).value !== undefined) {
      const control = element as HTMLInputElement;
      if (control.value && control.value.trim()) return;
      control.focus();
      control.value = value;
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (element.isContentEditable) {
      if (element.textContent && element.textContent.trim()) return;
      element.focus();
      element.textContent = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

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
      console.debug('[IndiaMART Agent] Filled contact message in visible input.');
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
      console.warn('[IndiaMART Agent] Chrome storage not available for loading skipped leads');
      return;
    }

    try {
      const result = await chrome.storage.local.get([SKIPPED_LEADS_KEY]);
      const storedIds = result[SKIPPED_LEADS_KEY];
      
      if (Array.isArray(storedIds) && storedIds.length > 0) {
        skippedLeads = new Set(storedIds.filter((id: any) => typeof id === 'string'));
        console.log(`[IndiaMART Agent] Loaded ${skippedLeads.size} skipped lead IDs from storage`);
      } else {
        skippedLeads = new Set<string>();
        console.log('[IndiaMART Agent] No skipped leads found in storage');
      }
    } catch (error) {
      console.error('[IndiaMART Agent] Error loading skipped leads:', error);
      skippedLeads = new Set<string>();
    }
  };

  // Add a lead ID to the skip list
  const addSkippedLead = async (leadId: string): Promise<void> => {
    if (!leadId || typeof leadId !== 'string') {
      console.warn('[IndiaMART Agent] Invalid leadId provided to addSkippedLead:', leadId);
      return;
    }

    // Add to in-memory set
    skippedLeads.add(leadId);

    // Save to storage
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      console.warn('[IndiaMART Agent] Chrome storage not available for saving skipped leads');
      return;
    }

    try {
      const idsArray = Array.from(skippedLeads);
      await chrome.storage.local.set({ [SKIPPED_LEADS_KEY]: idsArray });
      console.log(`[IndiaMART Agent] Added lead ${leadId} to skip list. Total skipped: ${skippedLeads.size}`);
    } catch (error) {
      console.error('[IndiaMART Agent] Error saving skipped lead:', error);
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
          console.log('[IndiaMART Agent] ✅ Detected "already purchased" dialog with OK button');
          return { detected: true, dialogElement: dialog, okButton };
        }
      }

      // Fallback: try to find OK button in the dialog
      if (dialog) {
        const buttons = dialog.querySelectorAll<HTMLElement>('button, .act_btns button');
        for (const btn of buttons) {
          const btnText = (btn.textContent || '').trim().toLowerCase();
          if (btnText.includes('ok') && isElementVisible(btn)) {
            console.log('[IndiaMART Agent] ✅ Detected "already purchased" dialog with OK button (fallback)');
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
      console.warn('[IndiaMART Agent] Error detecting already purchased dialog:', error);
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
        console.log('[IndiaMART Agent] Clicking OK button to dismiss "already purchased" dialog...');
        await clickWithFallback(detection.okButton, 'OK Button (Already Purchased)');
        await delay(1000); // Wait for dialog to close
        
        // Verify dialog is closed
        const stillVisible = detectAlreadyPurchasedDialog();
        if (!stillVisible.detected) {
          console.log('[IndiaMART Agent] ✅ Successfully dismissed "already purchased" dialog');
          return true;
        } else {
          console.warn('[IndiaMART Agent] ⚠️ Dialog still visible after clicking OK');
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
            console.log('[IndiaMART Agent] Clicking OK button (fallback) to dismiss dialog...');
            await clickWithFallback(btn, 'OK Button (Fallback)');
            await delay(1000);
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      console.error('[IndiaMART Agent] Error dismissing already purchased dialog:', error);
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
        console.log('[IndiaMART Agent] Clicking OK button to dismiss expired lead modal...');
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
            console.log('[IndiaMART Agent] Clicking OK button to dismiss expired lead modal...');
            await clickWithFallback(btn, 'OK Button');
            await delay(500);
            return true;
          }
        }

        // Last resort: try pressing Escape key
        console.log('[IndiaMART Agent] Trying to dismiss modal with Escape key...');
        detection.modalElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await delay(500);
        return true;
      }
    } catch (error) {
      console.error('[IndiaMART Agent] Error dismissing expired lead modal:', error);
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

  const parseQuantity = (value?: string | null): { raw?: string; quantity?: number } => {
    if (!value) return {};
    const raw = sanitize(value);
    const digits = raw.replace(/[^0-9.]/g, '');
    const quantity = digits ? Number(digits) : undefined;
    return {
      raw,
      quantity: typeof quantity === 'number' && Number.isFinite(quantity) ? quantity : undefined,
    };
  };

  const parseRupeeRange = (value?: string | null): { raw?: string; min?: number; max?: number } => {
    if (!value) return {};
    const raw = sanitize(value);

    // Identify scale keywords (lakh/crore) to adjust numeric values
    const lower = raw.toLowerCase();
    let scale = 1;
    if (/\b(crore|cr)\b/.test(lower)) {
      scale = 10000000;
    } else if (/\b(lakh|lac|lacs|l)\b/.test(lower)) {
      scale = 100000;
    }

    // Strip common currency prefixes so they don't interfere with parsing
    const withoutCurrency = raw.replace(/(?:rs\.?|inr|₹)/gi, ' ');

    // Extract numeric tokens (supports comma-separated thousands and decimals)
    const matches = withoutCurrency.match(/\d[\d,]*(?:\.\d+)?/g);
    if (!matches || matches.length === 0) {
      return { raw };
    }

    const numbers = matches
      .map((token) => token.replace(/,/g, ''))
      .map((token) => Number(token) * scale)
      .filter((num) => Number.isFinite(num));

    if (numbers.length === 0) {
      return { raw };
    }

    const min = numbers[0];
    const max = numbers.length > 1 ? numbers[numbers.length - 1] : numbers[0];
    return { raw, min, max };
  };

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
          console.log('[IndiaMART Agent] Added iframe context for scraping:', frame.id || frame.name || 'unnamed iframe');
        }
      } catch (error) {
        console.debug('[IndiaMART Agent] Unable to access iframe for scraping:', error);
      }
    });

    // Include known shadow roots if present
    const shadowHosts = Array.from(document.querySelectorAll<HTMLElement>('[data-shadow-host="lead"], indiamart-lead-feed')); // heuristic selectors
    shadowHosts.forEach((host) => {
      if (host.shadowRoot) {
        contexts.push(host.shadowRoot);
        console.log('[IndiaMART Agent] Added shadow DOM context for scraping:', host.tagName.toLowerCase());
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
          console.log(`[IndiaMART Agent] Found ${matches.length} elements via selector "${selector}" in ${contextLabel}`);
        }
      });
    });

    if (cards.length === 0) {
      if (!hasLoggedNoLeadCards) {
        console.warn('[IndiaMART Agent] No lead cards detected across any context. selectors:', LEAD_CARD_SELECTORS.join(', '));
        hasLoggedNoLeadCards = true;
      }
    } else {
      hasLoggedNoLeadCards = false;
    }

    return cards;
  };

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

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


  const ZERO_BALANCE_REGEXES = [
    /buylead\s+balance\s*:?\s*0/i,
    /buy\s*lead\s*balance\s*:?\s*0/i,
    /buy\s*leads\s*balance\s*:?\s*0/i,
  ];

  const detectZeroBalancePopup = (): boolean => {
    if (!document.body || zeroBalanceDetected) {
      return false;
    }

    try {
      const bodyText = document.body.innerText?.toLowerCase() || '';
      if (!bodyText) return false;
      return ZERO_BALANCE_REGEXES.some((regex) => regex.test(bodyText));
    } catch (error) {
      console.warn('[IndiaMART Agent] Failed to scan for zero balance popup:', error);
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
      console.debug('[IndiaMART Agent] Failed to parse BuyLead balance text:', error);
      return undefined;
    }
  };

  const notifyZeroBalanceSuspension = () => {
    try {
      chrome.runtime.sendMessage({ type: 'BUY_LEAD_BALANCE_ZERO' });
    } catch (error) {
      console.error('[IndiaMART Agent] Failed to notify background about zero balance:', error);
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

    console.warn('[IndiaMART Agent] Detected BuyLead balance 0 popup. Pausing automation until midnight.');
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
        console.log(`[IndiaMART Agent] Auto-scroll clicked potential load-more button via selector "${selector}".`);
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
        console.log(`[IndiaMART Agent] ✅ Found "Show More Suggested Leads" button by class selector`);
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
        console.log(`[IndiaMART Agent] ✅ Found "Show More Suggested Leads" button by text search`);
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
        console.log(`[IndiaMART Agent] ✅ "Show More Suggested Leads" button is already visible. Stopping scroll.`);
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

    console.log(`[IndiaMART Agent] Auto-scroll: scrolling until "Show More Suggested Leads" button is visible (currently ${existing} leads).`);

    const startTime = Date.now();
    const MAX_SCROLL_TIME_MS = 300000; // 300 second (5 minute) timeout
    let attempt = 0;
    let previousCount = existing;
    let noProgressCount = 0; // Track consecutive attempts with no progress

    let showMoreButtonFound = false;

    while (attempt < maxAttempts) {
      // Check timeout: if 5 minutes elapsed, break to avoid infinite scrolling
      if (Date.now() - startTime > MAX_SCROLL_TIME_MS) {
        console.log(`[IndiaMART Agent] Auto-scroll timeout reached. Current cards: ${getLeadCardElements().length}`);
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
            console.log(`[IndiaMART Agent] ✅ Found "Show More Suggested Leads" button: "${btnText}"! Scrolling to it and stopping...`);
          }
          
          // Scroll to button to ensure it's fully visible
          showMoreBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await delay(1000); // Wait for scroll to complete
          
          // Verify button is still visible after scroll
          const currentBtn = findShowMoreButton();
          if (currentBtn && isElementVisible(currentBtn)) {
            console.log(`[IndiaMART Agent] ✅ "Show More Suggested Leads" button is visible. Stopping scroll. Current leads: ${getLeadCardElements().length}`);
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
        console.log(`[IndiaMART Agent] Scrolling to absolute bottom (${scrollHeight}px) on attempt ${attempt}`);
        await delay(2000); // Wait longer for content to load after scrolling to bottom
      }

      // 1 second per lead scrolling: always scroll down, no random checks
      await performHumanScrollPass();

      // Try clicking "Load More" button (fallback - in case button text changes)
      const clicked = attemptClickLoadMore();
      if (clicked && !showMoreButtonFound) {
        console.log(`[IndiaMART Agent] "Load More" button clicked, waiting for content to load...`);
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
      console.log(`[IndiaMART Agent] Auto-scroll attempt ${attempt}: ${currentCount}/${minCount} cards found.`);

      // Check again for "Show More Suggested Leads" button - it might appear after scrolling
      const newShowMoreBtn = findShowMoreButton();
      if (newShowMoreBtn && isElementVisible(newShowMoreBtn)) {
        const btnText = (newShowMoreBtn.textContent || '').trim();
        // If "Show More Suggested Leads" button is visible, stop scrolling (don't click)
        if (btnText.includes('Show More Suggested Leads')) {
          if (!showMoreButtonFound) {
            showMoreButtonFound = true;
            console.log(`[IndiaMART Agent] ✅ Found "Show More Suggested Leads" button after scrolling! Stopping...`);
          }
          // Scroll to button to ensure it's fully visible, then stop
          newShowMoreBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await delay(1000);
          console.log(`[IndiaMART Agent] ✅ "Show More Suggested Leads" button is visible. Stopping scroll. Current leads: ${currentCount}`);
          break;
        }
      }

      // Continue scrolling if button not found yet
      if (!showMoreButtonFound && currentCount >= minCount) {
        // We have enough leads, but still scroll until we find the button
        console.log(`[IndiaMART Agent] Have ${currentCount} leads, but continuing to scroll until "Show More Suggested Leads" button is visible...`);
      }

      // Track progress - continue scrolling even if no progress for a while
      if (currentCount > previousCount) {
        console.log(`[IndiaMART Agent] Progress: ${previousCount} → ${currentCount} leads`);
        noProgressCount = 0; // Reset no progress counter
      } else {
        noProgressCount++;
        // Only warn if no progress for many attempts, but keep scrolling
        if (noProgressCount > 5 && noProgressCount % 3 === 0) {
          console.log(`[IndiaMART Agent] ⚠️ No progress for ${noProgressCount} attempts, scrolling to bottom to trigger loading...`);
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
    console.log(`[IndiaMART Agent] Auto-scroll completed after ${attempt} attempts in ${elapsedTime}s. Total cards available: ${finalCount}.`);
    
    // Don't refresh immediately - wait for 30 second refresh cycle
    if (finalCount >= minCount && isAutoContactEnabled && !isStopped) {
      console.log(`[IndiaMART Agent] ✅ Target of ${minCount} leads reached! Will continue until next 30-second refresh cycle.`);
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
    console.log(`[IndiaMART Agent] Aggregated ${cards.length} unique lead card elements across contexts`);
    const leads = cards.map((card, index) => extractLead(card, index));
    console.log('[IndiaMART Agent] Scraped leads data:', leads);
    return leads;
  };

  const findElementByText = (root: ParentNode, selector: string, text: string): HTMLElement | null => {
    const target = text.trim().toLowerCase();
    return Array.from(root.querySelectorAll<HTMLElement>(selector)).find((el) => el.textContent?.trim().toLowerCase() === target) || null;
  };

  const waitForElement = async (
    factory: () => HTMLElement | null,
    timeoutMs = 8000,
    intervalMs = 150
  ): Promise<HTMLElement | null> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = factory();
      if (el) return el;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  };

  const performContactFlow = async (cardIndex: number, lead?: Lead): Promise<{ success: boolean; error?: string }> => {
    const shouldAbort = () => isStopped || !isAutoContactEnabled;
    if (shouldAbort()) {
      console.info('[IndiaMART Agent] Contact flow aborted before start (auto-contact disabled or agent stopped).');
      return { success: false, error: 'Auto-contact disabled.' };
    }

    console.log(`[IndiaMART Agent] 🔄 Starting contact flow for lead: ${lead?.companyName || 'N/A'}, CardIndex: ${cardIndex}`);
    
    // Get cards and find the right card
    const cards = getLeadCardElements();
    console.log(`[IndiaMART Agent] Found ${cards.length} lead cards on page`);
    
    let card = cards[cardIndex];
    
    // If card not found by index, try to find by matching lead data
    if (!card && lead) {
      console.log(`[IndiaMART Agent] Card not found at index ${cardIndex}, trying to find by lead data...`);
      for (let i = 0; i < cards.length; i++) {
        const testCard = cards[i];
        const cardText = (testCard.textContent || '').toLowerCase();
        const enquiryTitleLower = (lead.enquiryTitle || '').toLowerCase();
        const companyNameLower = (lead.companyName || '').toLowerCase();
        
        // Match by enquiry title or company name
        if ((enquiryTitleLower && cardText.includes(enquiryTitleLower)) ||
            (companyNameLower && cardText.includes(companyNameLower))) {
          card = testCard;
          console.log(`[IndiaMART Agent] ✅ Found card at index ${i} by matching lead data`);
          break;
        }
      }
    }
    
    // Detect if we're on a detail page (no cards found or card not available)
    const isDetailPage = !card || cards.length === 0;
    
    if (isDetailPage) {
      console.log('[IndiaMART Agent] Detected detail page - using document-wide button search');
    }

    // Scroll card into view if it exists, otherwise scroll to top
    if (card && card instanceof HTMLElement) {
      console.log(`[IndiaMART Agent] Scrolling card into view...`);
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(1000); // Wait for scroll to complete
    } else if (isDetailPage) {
      // On detail pages, scroll to top to ensure button visibility
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await delay(1000);
    } else {
      console.warn(`[IndiaMART Agent] ⚠️ Card not found at index ${cardIndex} and could not match by lead data`);
    }

    // Enhanced button search: try multiple strategies with better logging
    console.log(`[IndiaMART Agent] 🔍 Searching for "Contact Buyer Now" button...`);
    const contactButton = await waitForElement(() => {
      // Strategy 1: Try finding button in card (if card exists)
      if (card) {
        const button = findElementByText(card, 'button, a', CONTACT_BUTTON_TEXT);
        if (isElementVisible(button)) {
          console.log(`[IndiaMART Agent] ✅ Found button in card using findElementByText`);
          return button;
        }
        const located = locateContactButton(card, false);
        if (isElementVisible(located)) {
          console.log(`[IndiaMART Agent] ✅ Found button in card using locateContactButton`);
          return located;
        }
      }
      
      // Strategy 2: Document-wide search (especially for detail pages)
      const docButton = findElementByText(document, 'button, a', CONTACT_BUTTON_TEXT);
      if (isElementVisible(docButton)) {
        console.log(`[IndiaMART Agent] ✅ Found button in document using findElementByText`);
        return docButton;
      }
      
      // Strategy 3: Use enhanced locateContactButton with document search
      const locatedDoc = locateContactButton(card, true);
      if (isElementVisible(locatedDoc)) {
        console.log(`[IndiaMART Agent] ✅ Found button in document using locateContactButton`);
        return locatedDoc;
      }
      
      // Strategy 4: Flexible text search in document
      const allButtons = document.querySelectorAll<HTMLElement>('button, a, [role="button"]');
      for (const btn of allButtons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        if ((text.includes('contact buyer') || ariaLabel.includes('contact buyer')) && isElementVisible(btn)) {
          console.log(`[IndiaMART Agent] ✅ Found button using flexible text search: "${text.substring(0, 50)}"`);
          return btn;
        }
      }
      
      return null;
    }, 15000); // Increased timeout to 15 seconds for better reliability

    if (shouldAbort()) {
      console.info('[IndiaMART Agent] Contact flow aborted after locating contact button (auto-contact disabled or agent stopped).');
      return { success: false, error: 'Auto-contact disabled.' };
    }

    if (!contactButton) {
      console.error(`[IndiaMART Agent] ❌ Contact button could not be located for card index: ${cardIndex}, Lead: ${lead?.companyName || 'N/A'}, Detail page: ${isDetailPage}`);
      console.error(`[IndiaMART Agent] Available buttons on page:`, Array.from(document.querySelectorAll('button, a')).slice(0, 5).map(b => b.textContent?.trim()).filter(Boolean));
      return { success: false, error: 'Contact Buyer Now button not found.' };
    }

    console.log(`[IndiaMART Agent] ✅ Contact button located! Button text: "${contactButton.textContent?.trim()}"`);
    console.log(`[IndiaMART Agent] 🖱️ Clicking Contact Buyer Now button for lead: ${lead?.companyName || cardIndex}`);
    
    // Ensure button is visible and in viewport before clicking
    contactButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await delay(500);
    
    await clickWithFallback(contactButton, 'Contact Buyer');
    console.log(`[IndiaMART Agent] ✅ Clicked Contact Buyer Now button for lead: ${lead?.companyName || cardIndex}`);

    // Wait for contact form/modal to appear after clicking Contact Buyer Now
    console.log(`[IndiaMART Agent] ⏳ Waiting for contact form to appear...`);
    await delay(1000); // Additional delay for form to load
    console.log(`[IndiaMART Agent] ✅ Contact form wait completed`);

    // Check for "already purchased" dialog first
    const alreadyPurchasedDialog = detectAlreadyPurchasedDialog();
    if (alreadyPurchasedDialog.detected) {
      console.warn('[IndiaMART Agent] ⚠️ "Already purchased" dialog detected for lead:', lead?.companyName || cardIndex, lead?.leadId);
      
      // Dismiss the dialog by clicking OK
      const dismissed = await dismissAlreadyPurchasedDialog();
      if (dismissed) {
        console.log('[IndiaMART Agent] ✅ Dismissed "already purchased" dialog');
      } else {
        console.warn('[IndiaMART Agent] ⚠️ Could not dismiss "already purchased" dialog automatically');
      }

      // Add to skip list since this lead is already purchased
      if (lead?.leadId) {
        await addSkippedLead(lead.leadId);
        console.log(`[IndiaMART Agent] ✅ Added lead ${lead.leadId} to skip list (already purchased).`);
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
      console.warn('[IndiaMART Agent] ⚠️ Expired/consumed lead error detected for lead:', lead?.companyName || cardIndex, lead?.leadId);
      
      // Extract leadId and add to skip list
      if (lead?.leadId) {
        await addSkippedLead(lead.leadId);
        console.log(`[IndiaMART Agent] ✅ Added lead ${lead.leadId} to skip list. This lead will be skipped in future refreshes.`);
      } else {
        console.warn('[IndiaMART Agent] Could not add lead to skip list: leadId not available');
      }

      // Dismiss the modal
      const dismissed = await dismissExpiredLeadModal();
      if (dismissed) {
        console.log('[IndiaMART Agent] ✅ Dismissed expired lead modal');
      } else {
        console.warn('[IndiaMART Agent] ⚠️ Could not dismiss expired lead modal automatically');
      }

      // Return early with specific error
      return { 
        success: false, 
        error: 'Lead expired or already consumed by maximum permissible sellers. Lead has been added to skip list.' 
      };
    }

    // Attempt to fill the message while the form loads
    console.log(`[IndiaMART Agent] 📝 Preparing to fill contact message...`);
    const desiredMessage = composeContactMessage(lead);
    console.log(`[IndiaMART Agent] Message preview: ${desiredMessage.substring(0, 100)}...`);
    let messageFilled = fillContactMessage(desiredMessage);
    if (messageFilled) {
      console.log(`[IndiaMART Agent] ✅ Message filled successfully`);
    }

    console.log(`[IndiaMART Agent] 🔍 Waiting for Send Reply button to appear...`);
    const replyButton = await waitForElement(() => {
      if (!messageFilled) {
        messageFilled = fillContactMessage(desiredMessage);
        if (messageFilled) {
          console.log(`[IndiaMART Agent] ✅ Message filled on retry`);
        }
      }

      const contexts = getInteractionContexts();
      for (const ctx of contexts) {
        for (const selector of SEND_REPLY_BUTTON_SELECTORS) {
          const candidate = ctx.querySelector<HTMLElement>(selector);
          if (isElementVisible(candidate)) {
            console.log(`[IndiaMART Agent] ✅ Found Send Reply button using selector: ${selector}`);
            return candidate;
          }
        }
      }

      const fallbackButton = findSendReplyButton();
      if (isElementVisible(fallbackButton)) {
        console.log(`[IndiaMART Agent] ✅ Found Send Reply button using findSendReplyButton fallback`);
        return fallbackButton;
      }
      
      return null;
    }, 20000);

    if (shouldAbort()) {
      console.info('[IndiaMART Agent] Contact flow aborted before Send Reply (auto-contact disabled or agent stopped).');
      return { success: false, error: 'Auto-contact disabled.' };
    }

    if (!replyButton) {
      console.error(`[IndiaMART Agent] ❌ Send Reply button not found after opening contact form for lead: ${lead?.companyName || 'N/A'}`);
      console.error(`[IndiaMART Agent] Available buttons:`, Array.from(document.querySelectorAll('button')).slice(0, 10).map(b => b.textContent?.trim()).filter(Boolean));
      return { success: false, error: 'Send Reply button not found after opening contact form.' };
    }
    
    console.log(`[IndiaMART Agent] ✅ Send Reply button found! Button text: "${replyButton.textContent?.trim()}"`);

    if (!messageFilled) {
      // Try one last time before sending
      messageFilled = fillContactMessage(desiredMessage);
      if (!messageFilled) {
        console.warn('[IndiaMART Agent] Could not locate a message field before sending reply. Proceeding with default behaviour.');
      }
    }

    // Ensure button is in view before clicking
    replyButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await delay(500); // Wait for scroll
    console.log(`[IndiaMART Agent] 🖱️ Clicking Send Reply button for lead: ${lead?.companyName || 'N/A'}`);

    if (shouldAbort()) {
      console.info('[IndiaMART Agent] Contact flow aborted before clicking Send Reply (auto-contact disabled or agent stopped).');
      return { success: false, error: 'Auto-contact disabled.' };
    }

    await clickWithFallback(replyButton, 'Send Reply');
    console.log(`[IndiaMART Agent] ✅ Clicked Send Reply button for lead: ${lead?.companyName || 'N/A'}`);

    // Give the site a moment to register the submission
    await delay(1200);

    let sendConfirmed = await waitForSendReplyConfirmation(6000);

    if (shouldAbort()) {
      console.info('[IndiaMART Agent] Contact flow aborted while waiting for confirmation (auto-contact disabled or agent stopped).');
      return { success: false, error: 'Auto-contact disabled.' };
    }

    if (!sendConfirmed) {
      // Check if button is still visible - if not, it might have been clicked successfully
      const buttonStillVisible = isSendReplyButtonVisible();
      const messageFieldStillVisible = !!getVisibleMessageField();
      
      // If both button and message field are gone, the form might have been submitted
      if (!buttonStillVisible && !messageFieldStillVisible) {
        console.log('[IndiaMART Agent] Send Reply button and message field disappeared - assuming successful submission');
        sendConfirmed = true;
      } else {
        console.warn('[IndiaMART Agent] Send Reply confirmation not detected after first attempt. Checking if message was already sent...');
        
        // Additional check: see if success indicators are present (they might have appeared quickly)
        await delay(1000); // Wait a bit more for potential success indicators
        sendConfirmed = await waitForSendReplyConfirmation(2000);
        
        if (!sendConfirmed && buttonStillVisible) {
          console.warn('[IndiaMART Agent] Still no confirmation detected. Retrying click ONLY if button is still visible and form is still open.');
          const retryButton =
            (replyButton.isConnected && isElementVisible(replyButton)) ?
              replyButton :
              await waitForElement(() => {
                const candidate = findSendReplyButton();
                return isElementVisible(candidate) ? candidate : null;
              }, 2000);

          if (retryButton && isSendReplyButtonVisible() && getVisibleMessageField()) {
            if (shouldAbort()) {
              console.info('[IndiaMART Agent] Contact flow aborted before retrying Send Reply (auto-contact disabled or agent stopped).');
              return { success: false, error: 'Auto-contact disabled.' };
            }

            console.debug('[IndiaMART Agent] Retrying Send Reply with fallback click support.');
            await clickWithFallback(retryButton, 'Send Reply Retry');
            await delay(1500);
            sendConfirmed = await waitForSendReplyConfirmation(6000);
          } else {
            console.warn('[IndiaMART Agent] Could not locate Send Reply button for retry OR form appears to have closed (message may have been sent).');
            // If button disappeared, assume it was sent
            if (!isSendReplyButtonVisible() && !getVisibleMessageField()) {
              sendConfirmed = true;
            }
          }
        }
      }
    }

    if (shouldAbort()) {
      console.info('[IndiaMART Agent] Contact flow aborted after retry (auto-contact disabled or agent stopped).');
      return { success: false, error: 'Auto-contact disabled.' };
    }

    if (!sendConfirmed) {
      const messageContent = getMessageFieldContent();
      const validationError = getSendReplyError();
      console.error('[IndiaMART Agent] Send Reply confirmation not detected after retry.', {
        replyButtonVisible: isSendReplyButtonVisible(),
        messageLength: messageContent.trim().length,
        validationError,
      });
      return { success: false, error: validationError || 'Send Reply confirmation not detected.' };
    }

    const leadDetails = lead || (card ? extractLead(card, cardIndex) : undefined);
    if (leadDetails) {
      await recordContactSuccess(leadDetails);
    }

    return { success: true };
  };

  // Removed duplicate startScrapeLoop - defined later in the file

  // Storage keys for filter configuration
  const FILTER_KEYWORDS_KEY = 'indiamart_filter_keywords';
  const FILTER_CATEGORIES_KEY = 'indiamart_filter_categories';
  const FILTER_QUANTITY_KEY = 'indiamart_filter_quantity';
  const FILTER_ORDER_VALUE_KEY = 'indiamart_filter_order_value';
  const DAILY_CONTACT_STATS_KEY = 'indiamart_daily_contact_stats';
  const CONTACT_HISTORY_WINDOW_DAYS = 10;

  // Default filter values (used as fallback)
  const DEFAULT_ENQUIRY_KEYWORDS = [
    'uniform', 'uniform fabric', 'uniform blazers', 'uniform jackets', 'school jackets', 'nurse uniform',
    'chef coats', 'coat', 'corporate uniform', 'staff uniform', 'ncc uniform', 'waiter uniform',
    'kids school uniform', 'school uniforms', 'school blazers', 'school blazer', 'school uniform fabric',
    'worker uniform', 'security guard uniform', 'petrol pump uniform', 'safety',
    'boys school uniform', 'girls school uniform', 'surgical gown', 'hospital uniforms'
  ];
  // const DEFAULT_ENQUIRY_KEYWORDS = [
  //   'uniform', 'uniform fabric' 
  // ];
  // const DEFAULT_ALLOWED_CATEGORIES = [
  //   'uniform'
  // ];
  const DEFAULT_ALLOWED_CATEGORIES = [
    'kids school uniform', 'kids school uniforms', 'school uniforms', 'school blazers', 'school blazer', 'school uniform fabric',
    'worker uniform', 'uniform fabric', 'security guard uniform', 'petrol pump uniform',
    'safety suits', 'boys school uniform', 'girls school uniform', 'surgical gown', 'hospital uniforms', 'corporate uniform', 'school college uniforms',
    'school jackets'
  ];

  // Mutable filter arrays (loaded from storage on init)
  let enquiryKeywords = [...DEFAULT_ENQUIRY_KEYWORDS];
  let allowedCategories = [...DEFAULT_ALLOWED_CATEGORIES];

  // List of all Indian states for location validation
  const INDIAN_STATES = [
    'Andhra Pradesh',
    'Arunachal Pradesh',
    'Assam',
    'Bihar',
    'Chhattisgarh',
    'Goa',
    'Gujarat',
    'Haryana',
    'Himachal Pradesh',
    'Jharkhand',
    'Karnataka',
    'Kerala',
    'Delhi',
    'Madhya Pradesh',
    'Maharashtra',
    'Manipur',
    'Meghalaya',
    'Mizoram',
    'Nagaland',
    'Odisha',
    'Punjab',
    'Rajasthan',
    'Sikkim',
    'Tamil Nadu',
    'Telangana',
    'Tripura',
    'Uttar Pradesh',
    'Uttarakhand',
    'West Bengal'
  ];
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

  // Validation helpers
  const validateKeyword = (keyword: string): boolean => {
    const trimmed = keyword.trim();
    return trimmed.length > 0 && trimmed.length <= 100;
  };

  const sanitizeKeyword = (keyword: string): string => {
    return keyword.trim().toLowerCase();
  };

  const getTodayIdentifier = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return {
      dateKey: `${year}-${month}-${day}`,
      dayOfWeek: now.getDay(),
    };
  };

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
      console.error('[IndiaMART Agent] Failed to load daily contact stats:', error);
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
    console.log(
      `[IndiaMART Agent] Daily quota usage: ${dailyContactStats.count}/${dailyContactStats.limit} (date ${dailyContactStats.date}).`
    );
    await saveDailyContactStats(dailyContactStats);
  };

  const notifyDailyLimitReached = () => {
    if (!dailyContactStats) return;
    chrome.runtime?.sendMessage?.({ type: 'DAILY_CONTACT_LIMIT_REACHED', payload: dailyContactStats });
  };

  const CONTACT_HISTORY_RETENTION_MS = CONTACT_HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const purgeStaleContactHistory = () => {
    const cutoff = Date.now() - CONTACT_HISTORY_RETENTION_MS;
    for (const [leadId, timestamp] of contactedLeadHistory.entries()) {
      if (timestamp < cutoff) {
        contactedLeadHistory.delete(leadId);
      }
    }
  };

  const loadContactHistory = async (): Promise<void> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      contactedLeadHistory = new Map();
      return;
    }
    try {
      const stored = await chrome.storage.local.get([CONTACT_SUCCESS_KEY]);
      const entries = stored[CONTACT_SUCCESS_KEY] as ContactSuccessEntry[] | undefined;
      contactedLeadHistory = new Map();
      if (Array.isArray(entries)) {
        entries.forEach((entry) => {
          if (entry.leadId && entry.contactedAt) {
            const ts = Date.parse(entry.contactedAt);
            if (!Number.isNaN(ts)) {
              contactedLeadHistory.set(entry.leadId, ts);
            }
          }
        });
      }
      purgeStaleContactHistory();
    } catch (error) {
      console.error('[IndiaMART Agent] Failed to load contact history:', error);
      contactedLeadHistory = new Map();
    }
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
      console.warn('[IndiaMART Agent] Chrome storage not available, using defaults');
      return;
    }

    try {
      const result = await chrome.storage.local.get([
        FILTER_KEYWORDS_KEY, 
        FILTER_CATEGORIES_KEY,
        FILTER_QUANTITY_KEY,
        FILTER_ORDER_VALUE_KEY
      ]);
      console.log('[IndiaMART Agent] Storage load result:', {
        hasKeywords: result[FILTER_KEYWORDS_KEY] !== undefined,
        hasCategories: result[FILTER_CATEGORIES_KEY] !== undefined,
        keywordsCount: Array.isArray(result[FILTER_KEYWORDS_KEY]) ? result[FILTER_KEYWORDS_KEY].length : 0,
        categoriesCount: Array.isArray(result[FILTER_CATEGORIES_KEY]) ? result[FILTER_CATEGORIES_KEY].length : 0
      });
      
      // Load keywords: update if key exists in storage (even if empty array)
      if (result[FILTER_KEYWORDS_KEY] !== undefined) {
        if (Array.isArray(result[FILTER_KEYWORDS_KEY])) {
          const storedKeywords = result[FILTER_KEYWORDS_KEY]
            .filter((k: string) => typeof k === 'string' && validateKeyword(k))
            .map((k: string) => k.trim())
            .slice(0, 500); // Limit to 500 items
          enquiryKeywords = storedKeywords;
          console.log(`[IndiaMART Agent] ✅ Updated keywords array from storage: ${enquiryKeywords.length} keywords`);
          console.log(`[IndiaMART Agent] Keywords list:`, enquiryKeywords.slice(0, 10), enquiryKeywords.length > 10 ? '...' : '');
        } else {
          console.warn('[IndiaMART Agent] Invalid keywords format in storage, using defaults');
          enquiryKeywords = [...DEFAULT_ENQUIRY_KEYWORDS];
        }
      } else {
        // Key doesn't exist in storage, use defaults and save them
        console.log('[IndiaMART Agent] No keywords in storage, using defaults and saving to storage');
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
          console.log(`[IndiaMART Agent] ✅ Updated categories array from storage: ${allowedCategories.length} categories`);
          console.log(`[IndiaMART Agent] Categories list:`, allowedCategories.slice(0, 10), allowedCategories.length > 10 ? '...' : '');
        } else {
          console.warn('[IndiaMART Agent] Invalid categories format in storage, using defaults');
          allowedCategories = [...DEFAULT_ALLOWED_CATEGORIES];
          await chrome.storage.local.set({ [FILTER_CATEGORIES_KEY]: DEFAULT_ALLOWED_CATEGORIES });
        }
      } else {
        // Key doesn't exist in storage, use defaults and save them
        console.log('[IndiaMART Agent] No categories in storage, using defaults and saving to storage');
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
          console.log(`[IndiaMART Agent] ✅ Updated quantity threshold from storage: ≥ ${quantityThreshold.min} ${quantityThreshold.unit}`);
        } else {
          console.warn('[IndiaMART Agent] Invalid quantity format in storage, using defaults');
          quantityThreshold = { min: 20, unit: 'piece' };
          await chrome.storage.local.set({ [FILTER_QUANTITY_KEY]: quantityThreshold });
        }
      } else {
        console.log('[IndiaMART Agent] No quantity threshold in storage, using defaults and saving to storage');
        quantityThreshold = { min: 20, unit: 'piece' };
        // Save defaults to storage for first-time initialization
        await chrome.storage.local.set({ [FILTER_QUANTITY_KEY]: quantityThreshold });
      }

      // Load order value minimum: update if key exists in storage
      if (result[FILTER_ORDER_VALUE_KEY] !== undefined) {
        const stored = result[FILTER_ORDER_VALUE_KEY];
        if (typeof stored === 'number' && stored >= 0 && stored <= 100000000) { // Validate range 0-100M
          orderValueMin = stored;
          console.log(`[IndiaMART Agent] ✅ Updated order value minimum from storage: ₹${orderValueMin.toLocaleString()}`);
        } else {
          console.warn('[IndiaMART Agent] Invalid order value format in storage, using defaults');
          orderValueMin = 5000;
          await chrome.storage.local.set({ [FILTER_ORDER_VALUE_KEY]: orderValueMin });
        }
      } else {
        console.log('[IndiaMART Agent] No order value minimum in storage, using defaults and saving to storage');
        orderValueMin = 5000;
        // Save defaults to storage for first-time initialization
        await chrome.storage.local.set({ [FILTER_ORDER_VALUE_KEY]: orderValueMin });
      }

      // Verify arrays are actually updated
      console.log('[IndiaMART Agent] Runtime arrays after load:', {
        enquiryKeywordsLength: enquiryKeywords.length,
        allowedCategoriesLength: allowedCategories.length,
        quantityThreshold: quantityThreshold,
        orderValueMin: orderValueMin,
        firstFewKeywords: enquiryKeywords.slice(0, 5),
        firstFewCategories: allowedCategories.slice(0, 5)
      });

      // Mark config as loaded
      filterConfigLoaded = true;
      console.log('[IndiaMART Agent] ✅ Filter config loaded and ready');
      
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
      console.error('[IndiaMART Agent] Error loading filter config from storage:', error);
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
      console.warn('[IndiaMART Agent] Chrome storage not available, cannot save');
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
        console.log('[IndiaMART Agent] Saved filter config to storage');
        return true;
      }

      return false;
    } catch (error) {
      console.error('[IndiaMART Agent] Error saving filter config to storage:', error);
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
      console.warn('[IndiaMART Agent] ⚠️ Filter config not loaded yet, skipping filter for:', lead.enquiryTitle);
      return { passed: false, reason: 'Filter config not loaded', nextContactDelayMinutes: 0 };
    }

    console.log(`[IndiaMART Agent] 🔍 Applying filters for: ${lead.companyName || 'N/A'}`);
    console.log(`  - Threshold: Quantity ≥ ${quantityThreshold.min} ${quantityThreshold.unit}, Order Value ≥ ₹${orderValueMin.toLocaleString()}`);

    // Note: We're using the runtime arrays (enquiryKeywords, allowedCategories) which are updated from storage
    // These arrays are NOT the hardcoded DEFAULT arrays - they're mutable variables that get updated

    // Filter 1: Enquiry Title Keywords (universal uniform check + keyword list)
    const titleLower = (lead.enquiryTitle || lead.requirement || '').toLowerCase();
    console.log(`  - Filter 1 (Keywords): Checking title "${lead.enquiryTitle || lead.requirement || 'N/A'}"`);
    
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
      console.log(`  - Filter 1: ❌ FAILED - No uniform keywords found in title`);
      return { passed: false, reason: 'No uniform keywords found', nextContactDelayMinutes: 0 };
    }
    console.log(`  - Filter 1: ✅ PASSED - Found uniform keyword`);
    
    // Filter 2: State validation - check if state is in Indian states list
    const location = lead.location || '';
    console.log(`  - Filter 2 (State): Checking location "${location}"`);
    
    if (!location || location === 'N/A') {
      console.log(`  - Filter 2: ⚠️ No location found, skipping state check`);
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
        console.log(`  - Filter 2: ❌ FAILED - State "${state}" is not in Indian states list`);
        return { passed: false, reason: `State "${state}" not in Indian states list`, nextContactDelayMinutes: 0 };
      }
      console.log(`  - Filter 2: ✅ PASSED - State "${state}" is a valid Indian state`);
    }
    
    // Filter 3: Quantity ≥ threshold (flexible - check number first, unit match optional)
    console.log(`  - Filter 3 (Quantity): Checking quantity ${lead.quantity || 'N/A'} (raw: ${lead.quantityRaw || 'N/A'})`);
    
    // Special handling: If title contains "coat", use lower quantity threshold (10 pieces)
    const hasCoatKeyword = titleLower.includes('coat');
    const effectiveQuantityThreshold = hasCoatKeyword ? 10 : quantityThreshold.min;
    
    if (hasCoatKeyword) {
      console.log(`  - Filter 3: ⚠️ "Coat" keyword detected - using lower quantity threshold: ${effectiveQuantityThreshold} pieces`);
    }
    
    // First check: quantity number must meet threshold
    const quantityMeetsThreshold = typeof lead.quantity === 'number' && lead.quantity >= effectiveQuantityThreshold;
    
    if (!quantityMeetsThreshold) {
      console.log(`  - Filter 3: ❌ FAILED - Quantity ${lead.quantity || 'N/A'} < ${effectiveQuantityThreshold}`);
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
        console.log(`  - Filter 3: ⚠️ Quantity ${lead.quantity} meets threshold, but quantityRaw "${lead.quantityRaw}" doesn't match unit "${quantityThreshold.unit}" - still passing filter`);
      }
    }
    console.log(`  - Filter 3: ✅ PASSED - Quantity ${lead.quantity} >= ${effectiveQuantityThreshold}`);
    
    // Filter 4: Category match
    const categoryLower = (lead.category || '').toLowerCase();
    console.log(`  - Filter 4 (Category): Checking category "${lead.category || 'N/A'}"`);
    
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
      console.log(`  - Filter 4: ❌ FAILED - Category "${lead.category}" not in allowed list`);
      return { passed: false, reason: 'Category not in allowed list', nextContactDelayMinutes: 0 };
    }
    if (!lead.category) {
      console.log(`  - Filter 4: ⚠️ No category found, skipping category check`);
    } else {
      console.log(`  - Filter 4: ✅ PASSED - Category "${lead.category}" matches`);
    }
    
    // Filter 5: Probable Order Value ≥ ₹10,000
    const orderValue = lead.probableOrderValueMin || lead.probableOrderValueMax || 0;
    console.log(`  - Filter 5 (Order Value): Checking order value ${orderValue} (Min: ${lead.probableOrderValueMin || 'N/A'}, Max: ${lead.probableOrderValueMax || 'N/A'})`);
    if (orderValue < orderValueMin) {
      console.log(`  - Filter 5: ❌ FAILED - Order value ${orderValue} < ${orderValueMin}`);
      return { passed: false, reason: `Order value < ₹${orderValueMin.toLocaleString()}`, nextContactDelayMinutes: 0 };
    }
    console.log(`  - Filter 5: ✅ PASSED - Order value ${orderValue} >= ${orderValueMin}`);
    
    // Generate random delay between 1-10 minutes for qualified leads
    const delayOptions = [1, 5, 10];
    const randomDelay = delayOptions[Math.floor(Math.random() * delayOptions.length)];
    
    console.log(`[IndiaMART Agent] ✅ ALL FILTERS PASSED for ${lead.companyName || 'N/A'}`);
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
    console.log(
      `[IndiaMART Agent] Next processing cycle in ${lastScheduledProcessingWindow}.`
    );

    processingTimer = setTimeout(async () => {
      processingTimer = null;
      if (!isStopped && isAutoContactEnabled) {
        try {
          await processLeadsWithFiltering();
        } catch (error) {
          console.error('[IndiaMART Agent] Processing cycle failed:', error);
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
    console.log(`[IndiaMART Agent] Next refresh scheduled in ${lastScheduledRefreshWindow}.`);

    pageRefreshTimer = setTimeout(() => {
      if (!isStopped && isAutoContactEnabled) {
        lastRefreshTime = Date.now();
        console.log('IndiaMART Agent: Stealth refresh triggered.');
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
      console.log('[IndiaMART Agent] ⛔ Auto-contact disabled, aborting contact for:', lead.companyName);
      return false;
    }
    
    // Check if this lead was already processed/contacted to prevent duplicates
    if (processedLeads.has(lead.leadId)) {
      console.log(`[IndiaMART Agent] ⚠️ Lead ${lead.leadId} (${lead.companyName}) already in processedLeads, skipping duplicate contact`);
      return false;
    }
    
    if (wasLeadContactedRecently(lead.leadId)) {
      console.log(`[IndiaMART Agent] ⚠️ Lead ${lead.leadId} (${lead.companyName}) was contacted recently, skipping duplicate contact`);
      return false;
    }
    
    return withContactLock(async () => {
      // Double-check after acquiring lock (another thread might have processed it)
      if (processedLeads.has(lead.leadId)) {
        console.log(`[IndiaMART Agent] ⚠️ Lead ${lead.leadId} (${lead.companyName}) was processed by another thread, skipping duplicate contact`);
        return false;
      }
      
      // Mark as processing immediately to prevent concurrent attempts
      processedLeads.add(lead.leadId);
      
      // Check again after acquiring lock
      if (!isAutoContactEnabled || isStopped) {
        console.log('[IndiaMART Agent] ⛔ Auto-contact disabled after lock acquisition, aborting contact for:', lead.companyName);
        processedLeads.delete(lead.leadId); // Remove from processed since we didn't actually contact
        return false;
      }
      
      try {
        const result = await performContactFlow(cardIndex, lead);
        
        // Check again after contact flow completes
        if (!isAutoContactEnabled || isStopped) {
          console.log('[IndiaMART Agent] ⛔ Auto-contact disabled after contact flow, skipping success handling for:', lead.companyName);
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
          
          console.log(`[IndiaMART Agent] ✅ Successfully contacted: ${lead.companyName} (${contactedLeadsCount}/${filteredLeadsCount})`);
          
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
        console.error('Error contacting lead:', error);
        registerAutomationError((error as Error)?.message || 'Unknown contact flow error');
      }
      
      return false;
    });
  };

  // Storage helper functions and keys
  // Note: These constants must match background.ts for consistency
  const STORAGE_KEY = 'indiamart_logs'; // legacy diagnostics stream (optional)
  const SUMMARIES_KEY = 'indiamart_summaries'; // array of summary blocks
  const LEAD_LOGS_KEY = 'indiamart_lead_logs'; // array of detailed per-lead logs
  const DIAGNOSTICS_KEY = 'indiamart_diagnostics'; // diagnostics stream (optional)
  const CONTACT_SUCCESS_KEY = 'indiamart_contact_successes'; // successful contact history
  const MAX_LOG_LINES = 1000; // Maximum number of diagnostic log lines to keep
  const MAX_SUMMARIES = 20; // keep last N summaries
  const MAX_LEAD_LOGS = 20; // keep last N detailed log blocks
  const MAX_CONTACT_SUCCESS = 200; // keep last N successful contacts (extended for 10-day tracking)
  const DIAGNOSTICS_ENABLED = false; // default off

  const LAST_SIGNATURE_KEY = 'indiamart_last_signature';

  interface LeadEvaluation {
    lead: Lead;
    passed: boolean;
    reason: string;
  }

  interface ContactSuccessEntry {
    leadId?: string;
    companyName?: string;
    enquiryTitle?: string;
    location?: string;
    contactedAt: string;
    probableOrderValue?: string;
  }

  interface CycleSummaryMeta {
    timestamp: string;
    totalLeads: number;
    qualifiedLeads: number;
    selectedLeads: Array<{ id?: string; company?: string; orderValue?: string }>;
    skippedLeads: number;
    dailyStats: DailyContactStats | null;
    buyLeadBalance?: number;
    actions: string[];
    errors: string[];
    backoffActive: boolean;
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

  const recordContactSuccess = async (lead: Lead): Promise<void> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return;
    }

    try {
      const entry: ContactSuccessEntry = {
        leadId: lead.leadId,
        companyName: lead.companyName || undefined,
        enquiryTitle: lead.enquiryTitle || lead.requirement || undefined,
        location: lead.location || undefined,
        contactedAt: new Date().toISOString(),
        probableOrderValue: formatOrderValueRange(lead),
      };

      const result = await chrome.storage.local.get([CONTACT_SUCCESS_KEY]);
      const existing: ContactSuccessEntry[] = Array.isArray(result[CONTACT_SUCCESS_KEY])
        ? result[CONTACT_SUCCESS_KEY]
        : [];

      const withoutDuplicate = entry.leadId
        ? existing.filter((item) => item.leadId !== entry.leadId)
        : existing.slice();

      const updated = [...withoutDuplicate, entry].slice(-MAX_CONTACT_SUCCESS);
      await chrome.storage.local.set({ [CONTACT_SUCCESS_KEY]: updated });
      if (entry.leadId) {
        contactedLeadHistory.set(entry.leadId, Date.now());
        purgeStaleContactHistory();
      }

      if (chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'CONTACT_SUCCESS_UPDATED', entry });
      }
    } catch (error) {
      console.error('[IndiaMART Agent] Failed to record contact success:', error);
    }
  };

  const saveFilteringSummaryToStorage = async (
    totalLeads: number,
    filteredLeadsCount: number,
    rejectedLeads: number,
    filteredLeads: Lead[],
    evaluations: LeadEvaluation[],
    selectedLeads: Lead[],
    cycleSummary: CycleSummaryMeta
  ): Promise<void> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      console.warn('[IndiaMART Agent] Chrome storage API not available');
      return;
    }

    try {
      const timestamp = new Date().toISOString();
      const dateStr = new Date().toLocaleString();

      // Build a stable signature of the meaningful data
      const signaturePayload = {
        totalLeads,
        filteredLeadsCount,
        rejectedLeads,
        filtered: filteredLeads.map(l => ({
          id: l.leadId,
          c: l.companyName,
          e: l.enquiryTitle,
          loc: l.location
        })),
        evaluations: evaluations.map((entry) => ({
          id: entry.lead.leadId,
          passed: entry.passed,
          reason: entry.reason
        })),
        selected: selectedLeads.map((lead) => lead.leadId),
        actions: cycleSummary.actions,
        errors: cycleSummary.errors
      };
      const signature = JSON.stringify(signaturePayload);

      // Get existing summaries/diagnostics and previous signature
      const result = await chrome.storage.local.get([SUMMARIES_KEY, LEAD_LOGS_KEY, DIAGNOSTICS_KEY, LAST_SIGNATURE_KEY]);
      const existingSummaries: string[] = Array.isArray(result[SUMMARIES_KEY]) ? result[SUMMARIES_KEY] : [];
      const existingLeadLogs: string[] = Array.isArray(result[LEAD_LOGS_KEY]) ? result[LEAD_LOGS_KEY] : [];
      const existingDiagnostics: string = result[DIAGNOSTICS_KEY] || '';
      const previousSignature: string | undefined = result[LAST_SIGNATURE_KEY];

      // If nothing changed, skip writing logs
      if (previousSignature === signature) {
        console.log('[IndiaMART Agent] No change in filtering summary. Skipping log write.');
        return;
      }

      // Create readable log entries
      const logEntries: string[] = [];
      
      logEntries.push(`\n========== FILTERING SUMMARY - ${dateStr} ==========`);
      logEntries.push(`[${timestamp}] [IndiaMART Agent] ========== FILTERING SUMMARY ==========`);
      logEntries.push(`[${timestamp}] [IndiaMART Agent] Total leads: ${totalLeads}`);
      logEntries.push(`[${timestamp}] [IndiaMART Agent] Filtered (qualified) leads: ${filteredLeadsCount}`);
      logEntries.push(`[${timestamp}] [IndiaMART Agent] Rejected leads: ${rejectedLeads}`);
      logEntries.push(`[${timestamp}] [IndiaMART Agent] Selected this cycle: ${selectedLeads.length}`);
      
      if (filteredLeads.length > 0) {
        logEntries.push(`[${timestamp}] [IndiaMART Agent] Filtered leads list:`);
        filteredLeads.forEach((lead, index) => {
          logEntries.push(`[${timestamp}] [IndiaMART Agent]   ${index + 1}. Company: ${lead.companyName}, Enquiry: ${lead.enquiryTitle}, Location: ${lead.location}`);
        });
      } else {
        logEntries.push(`[${timestamp}] [IndiaMART Agent] Filtered leads list: Array(0)`);
      }

      if (selectedLeads.length > 0) {
        logEntries.push(`[${timestamp}] [IndiaMART Agent] Selected leads this cycle:`);
        selectedLeads.forEach((lead, index) => {
          logEntries.push(
            `[${timestamp}] [IndiaMART Agent]   ${index + 1}. ${lead.companyName} — ${formatOrderValueRange(lead) || 'N/A'}`
          );
        });
      }

      if (cycleSummary.dailyStats) {
        logEntries.push(
          `[${timestamp}] [IndiaMART Agent] Daily quota: ${cycleSummary.dailyStats.count}/${cycleSummary.dailyStats.limit}`
        );
      }

      if (typeof cycleSummary.buyLeadBalance === 'number') {
        logEntries.push(
          `[${timestamp}] [IndiaMART Agent] Remaining buy lead balance (estimate): ${cycleSummary.buyLeadBalance}`
        );
      }

      if (cycleSummary.actions.length) {
        logEntries.push(`[${timestamp}] [IndiaMART Agent] Actions: ${cycleSummary.actions.join(' | ')}`);
      }

      if (cycleSummary.errors.length) {
        logEntries.push(`[${timestamp}] [IndiaMART Agent] Errors: ${cycleSummary.errors.join(' | ')}`);
      }
      
      logEntries.push(`[${timestamp}] [IndiaMART Agent] URL: ${window.location.href}`);
      logEntries.push(`========== END SUMMARY ==========\n`);

      // Final summary block (only this goes to summaries)
      const summaryBlock = logEntries.join('\n');
      const detailEntries: string[] = [];
      detailEntries.push(`\n========== LEAD DETAILS - ${dateStr} ==========`);      
      if (evaluations.length === 0) {
        detailEntries.push(`[${timestamp}] [IndiaMART Agent] No leads evaluated in this cycle.`);
      } else {
        evaluations.forEach((entry, idx) => {
          const lead = entry.lead;
          const status = entry.passed ? 'PASS' : 'REJECT';
          const qtyText = typeof lead.quantity === 'number' ? `${lead.quantity}` : 'N/A';
          const qtyRaw = lead.quantityRaw || 'N/A';
          const orderValue = lead.probableOrderValueMin || lead.probableOrderValueMax
            ? `₹${lead.probableOrderValueMin || 0} - ₹${lead.probableOrderValueMax || 0}`
            : 'N/A';
          detailEntries.push(`[${timestamp}] [IndiaMART Agent] ${idx + 1}. [${status}] ${lead.companyName} — ${lead.enquiryTitle || 'No enquiry title'}`);
          detailEntries.push(`    Reason: ${entry.reason}`);
          detailEntries.push(`    Location: ${lead.location || 'N/A'}`);
          detailEntries.push(`    Quantity: ${qtyText} (${qtyRaw})`);
          detailEntries.push(`    Category: ${lead.category || 'N/A'}`);
          detailEntries.push(`    Order Value: ${orderValue}`);
        });
      }
      detailEntries.push(`[${timestamp}] [IndiaMART Agent] URL: ${window.location.href}`);
      detailEntries.push(`========== END LEAD DETAILS ==========\n`);
      const detailBlock = detailEntries.join('\n');

      // Append to summaries with cap
      const newSummaries = [...existingSummaries, summaryBlock].slice(-MAX_SUMMARIES);
      const newLeadLogs = [...existingLeadLogs, detailBlock].slice(-MAX_LEAD_LOGS);

      // Optionally append to diagnostics stream
      let newDiagnostics = existingDiagnostics;
      if (DIAGNOSTICS_ENABLED) {
        const combined = existingDiagnostics + '\n' + summaryBlock;
        const diagLines = combined.split('\n');
        newDiagnostics = diagLines.slice(-MAX_LOG_LINES).join('\n');
      }

      // Save to storage and update last signature
      const toSave: Record<string, any> = { [SUMMARIES_KEY]: newSummaries, [LEAD_LOGS_KEY]: newLeadLogs, [LAST_SIGNATURE_KEY]: signature };
      if (DIAGNOSTICS_ENABLED) toSave[DIAGNOSTICS_KEY] = newDiagnostics;
      await chrome.storage.local.set(toSave);
      console.log('[IndiaMART Agent] Filtering summary saved to Chrome storage (summaries list)');
    } catch (error) {
      console.error('[IndiaMART Agent] Error saving filtering summary logs to storage:', error);
    }
  };

  const processLeadsWithFiltering = async () => {
    if (!isAutoContactEnabled || isStopped) {
      lastProcessingTime = Date.now();
      return;
    }

    if (!filterConfigLoaded) {
      lastProcessingTime = Date.now();
      console.log('[IndiaMART Agent] ⏳ Waiting for filter config to load before processing leads...');
      return;
    }

    if (isLeadProcessingRunning) {
      lastProcessingTime = Date.now();
      console.debug('[IndiaMART Agent] Skipping processLeadsWithFiltering - already running.');
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
        console.log(
          `[IndiaMART Agent] Waiting ${(waitMs / 1000).toFixed(
            1
          )}s after refresh before scanning leads.`
        );
        await delay(waitMs);
      }

      // Scroll until "Show More Suggested Leads" button is visible (don't click it)
      await ensureMinimumLeadCards(MIN_LEAD_TARGET);
      
      // Process ALL leads available on the page (not limited to 50)
      const leads = scrapeLeads();
      console.log(`[IndiaMART Agent] Processing all ${leads.length} leads available on the page`);
      const skipIndexes = pickRandomSkipIndexes(leads.length);
      const filteredLeads: Lead[] = [];
      const leadEvaluations: LeadEvaluation[] = [];
      const cycleErrors: string[] = [];
      const cycleActions: string[] = [];
      const cycleTimestamp = new Date().toISOString();
      filteredLeadsCount = 0;
      contactedLeadsCount = 0;
      pendingContacts = [];

      console.log('[IndiaMART Agent] Processing leads with stealth filtering...');
      console.log('[IndiaMART Agent] Total leads to process:', leads.length);

      for (const [index, lead] of leads.entries()) {
        // Check if auto-contact was disabled during processing
        if (!isAutoContactEnabled || isStopped) {
          console.log('[IndiaMART Agent] ⛔ Auto-contact disabled during lead processing loop, stopping...');
          break;
        }
        
        if (processedLeads.has(lead.leadId)) {
          console.log(`[IndiaMART Agent] Skipping already processed lead: ${lead.companyName}`);
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
          console.log('[IndiaMART Agent] ⛔ Auto-contact disabled after reading delay, stopping...');
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
        console.log(`[IndiaMART Agent] 🔍 Processing lead: ${lead.companyName || 'N/A'}`);
        console.log(`  - Enquiry Title: ${lead.enquiryTitle || 'N/A'}`);
        console.log(`  - Category: ${lead.category || 'N/A'}`);
        console.log(`  - Quantity: ${lead.quantity || 'N/A'} (raw: ${lead.quantityRaw || 'N/A'})`);
        console.log(`  - Order Value: Min=${lead.probableOrderValueMin || 'N/A'}, Max=${lead.probableOrderValueMax || 'N/A'}, Raw=${lead.probableOrderValueRaw || 'N/A'}`);
        console.log(`  - Location: ${lead.location || 'N/A'}`);
        console.log(`  - Lead ID: ${lead.leadId || 'N/A'}`);
        console.log(`  - Card Index: ${lead.cardIndex !== undefined ? lead.cardIndex : 'N/A'}`);

        const filterResult = applyIntelligentFilter(lead);
        lead.passedFilter = filterResult.passed;
        lead.filterReason = filterResult.reason;
        lead.nextContactDelayMinutes = filterResult.nextContactDelayMinutes;
        leadEvaluations.push({ lead, passed: filterResult.passed, reason: filterResult.reason });

        console.log(`[IndiaMART Agent] ✅ Filter Result: ${filterResult.passed ? 'PASSED' : 'FAILED'}`);
        console.log(`  - Reason: ${filterResult.reason}`);

        if (filterResult.passed) {
          // Add to filtered leads array for statistics/logging
          filteredLeads.push(lead);
          filteredLeadsCount = filteredLeads.length;

          // Immediately process this lead if auto-contact is enabled and quota allows
          if (isAutoContactEnabled && !isStopped && canContactMoreToday()) {
            // Double-check that lead hasn't been processed/contacted already
            if (processedLeads.has(lead.leadId)) {
              console.log(`[IndiaMART Agent] ⚠️ Lead ${lead.leadId} already processed, skipping contact`);
              continue;
            }
            if (wasLeadContactedRecently(lead.leadId)) {
              console.log(`[IndiaMART Agent] ⚠️ Lead ${lead.leadId} was contacted recently, skipping contact`);
              continue;
            }
            
            console.log(`[IndiaMART Agent] 🎯 Lead passed filters - immediately clicking "Contact Buyer Now" for: ${lead.companyName || lead.leadId}`);
            
            const contacted = await processFilteredLead(lead, lead.cardIndex || 0);
            if (contacted) {
              await incrementDailyContactCount();
              // Note: contactedLeadHistory is already set in processFilteredLead via recordContactSuccess
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

      console.log('[IndiaMART Agent] ========== FILTERING SUMMARY ==========');
      console.log(`[IndiaMART Agent] Total leads: ${leads.length}`);
      console.log(`[IndiaMART Agent] Filtered (qualified) leads: ${filteredLeadsCount}`);
      console.log(`[IndiaMART Agent] Contacted leads this cycle: ${contactedLeadsCount}`);

      await saveFilteringSummaryToStorage(
        leads.length,
        filteredLeadsCount,
        leads.length - filteredLeadsCount,
        filteredLeads,
        leadEvaluations,
        filteredLeads, // All filtered leads are now selected/processed immediately
        cycleSummary
      );
      try {
        chrome.runtime?.sendMessage?.({ type: 'LOGS_UPDATED' });
      } catch {}

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
        console.log('[IndiaMART Agent] ⚡ No leads remain to contact. Refreshing page immediately...');
        console.log(`  - No leads passed filters: ${noLeadsPassedFilters}`);
        console.log(`  - All filtered leads contacted: ${allFilteredLeadsContacted}`);
        console.log(`  - No remaining contactable leads: ${noLeadsRemainToContact}`);
        
        // Clear the periodic refresh timer since we're refreshing now
        if (pageRefreshTimer) {
          clearTimeout(pageRefreshTimer);
          pageRefreshTimer = null;
        }
        
        // Refresh immediately
        lastRefreshTime = Date.now();
        await delay(1000); // Small delay to ensure logs are saved
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
    const timestamp = new Date().toISOString();

    if (!isTabVisible && wasVisible) {
      // Tab became inactive
      tabWentInactiveTime = Date.now();
      console.log('[IndiaMART Agent] Tab became INACTIVE - logging status...');
      
      // Save inactive status to diagnostics only (optional)
      if (DIAGNOSTICS_ENABLED && typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(DIAGNOSTICS_KEY, (result) => {
          const existingDiag: string = result[DIAGNOSTICS_KEY] || '';
          const inactiveLog = `\n[${timestamp}] [Content Script] ⚠️ Tab hidden: automation continues in background; Chrome may throttle activity while hidden.\n`;
          const combined = existingDiag + inactiveLog;
          const lines = combined.split('\n');
          const trimmed = lines.slice(-MAX_LOG_LINES).join('\n');
          chrome.storage.local.set({ [DIAGNOSTICS_KEY]: trimmed });
        });
      }
    }

    if (isTabVisible && !wasVisible) {
      // Tab became visible again
      const timeInactive = tabWentInactiveTime > 0 ? Date.now() - tabWentInactiveTime : Date.now() - lastProcessingTime;
      const minutesInactive = Math.floor(timeInactive / 60000);
      const secondsInactive = Math.floor((timeInactive % 60000) / 1000);
      
      console.log(`[IndiaMART Agent] ✅ Tab became VISIBLE after ${minutesInactive}m ${secondsInactive}s. Resuming processing...`);
      
      // Save resume log to diagnostics only (optional)
      if (DIAGNOSTICS_ENABLED && typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(DIAGNOSTICS_KEY, (result) => {
          const existingDiag: string = result[DIAGNOSTICS_KEY] || '';
          const resumeLog = `\n[${timestamp}] [Content Script] ✅ Tab visible: continuing automation after ${minutesInactive}m ${secondsInactive}s.\n`;
          const combined = existingDiag + resumeLog;
          const lines = combined.split('\n');
          const trimmed = lines.slice(-MAX_LOG_LINES).join('\n');
          chrome.storage.local.set({ [DIAGNOSTICS_KEY]: trimmed });
        });
      }
      
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
        .catch((error) => console.warn('[IndiaMART Agent] Auto-scroll failed before SCRAPE_NOW:', error))
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
      console.log('[IndiaMART Agent] ⛔ DISABLE_AUTO_CONTACT received - stopping all processing');
      resetAutomationState({ stopped: false });
      isLeadProcessingRunning = false; // Force stop any ongoing processing
      contactInFlight = false; // Cancel any in-flight contacts
      console.log('[IndiaMART Agent] ✅ Auto-contact disabled, all timers stopped and processing aborted');
      sendResponse({ success: true });
      return true;
    }
    
    if (message.type === 'STOP_AGENT') {
      console.log('[IndiaMART Agent] 🛑 STOP_AGENT received - stopping all processes...');
      
      // Force stop all flags immediately
      isStopped = true;
      isAutoContactEnabled = false;
      isLeadProcessingRunning = false;
      contactInFlight = false;
      
      // Reset all automation state (stops timers, observers, etc.)
      resetAutomationState({ stopped: true });
      
      console.log('[IndiaMART Agent] ✅ Agent stopped - all processes terminated');
      sendResponse({ success: true });
      return true;
    }
    
    if (message.type === 'SCRAPE_AND_FILTER') {
      processLeadsWithFiltering();
      sendResponse({ success: true });
      return true;
    }
    
    if (message.type === 'PROCESS_LEADS_FOR_LOGS') {
      // Background script requested processing for logs (via alarm/heartbeat)
      // This ensures logs are saved even when tab might be inactive
      if (isAutoContactEnabled && !isStopped) {
        processLeadsWithFiltering();
        // Notify background that processing was successful
        chrome.runtime.sendMessage({ type: 'LOG_PROCESSING_SUCCESS' });
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, reason: 'Auto-contact disabled or stopped' });
      }
      return true;
    }

    if (message.type === 'FILTER_KEYWORDS_UPDATED') {
      // Reload filter config from storage and re-run filtering if active
      console.log('[IndiaMART Agent] 📥 Received FILTER_KEYWORDS_UPDATED message, reloading filter config from storage...');
      loadFilterConfig()
        .then(() => {
          console.log(`[IndiaMART Agent] ✅ Filter config reloaded successfully!`);
          console.log(`[IndiaMART Agent] Runtime arrays now:`, {
            keywordsCount: enquiryKeywords.length,
            categoriesCount: allowedCategories.length,
            keywords: enquiryKeywords.slice(0, 10),
            categories: allowedCategories.slice(0, 10)
          });
          
          // Notify popup of updated criteria
          chrome.runtime.sendMessage({ type: 'FILTER_CRITERIA_UPDATE', payload: getFilterCriteria() });
          
          // Re-run filtering if auto-contact is enabled
          if (isAutoContactEnabled && !isStopped) {
            console.log('[IndiaMART Agent] 🔄 Re-running filtering with updated arrays...');
            processLeadsWithFiltering();
          }
        })
        .catch((error) => {
          console.error('[IndiaMART Agent] ❌ Error reloading filter config:', error);
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
        .catch((error) => console.warn('[IndiaMART Agent] Auto-scroll failed during initial scrape:', error))
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
          console.log('[IndiaMART Agent] Filter config changed in storage, reloading...');
          loadFilterConfig().catch((error) => {
            console.error('[IndiaMART Agent] Error reloading filter config after storage change:', error);
          });
        }
      }
    });
  }

  // Initialize: Load filter config and skipped leads from storage, then start observers
  void Promise.all([loadFilterConfig(), loadSkippedLeads(), loadDailyContactStats(), loadContactHistory()])
    .then(() => {
      console.log('[IndiaMART Agent] Filter config and skipped leads initialized from storage');
      startZeroBalanceObserver();
      syncAutoContactState();
    })
    .catch((error) => {
      console.error('[IndiaMART Agent] Failed to load config, using defaults:', error);
      startZeroBalanceObserver();
      syncAutoContactState();
    });
})(); // End of IIFE
