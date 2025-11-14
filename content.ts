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
  const REFRESH_INTERVAL = 30 * 1000; // 30 seconds
  const MIN_LEAD_TARGET = 50; // desired minimum number of leads before processing
  const AUTO_SCROLL_MAX_ATTEMPTS = 8;
  const AUTO_SCROLL_DELAY_MS = 1200;
  const AUTO_SCROLL_COOLDOWN_MS = 60 * 1000;
  const DEFAULT_CONTACT_MESSAGE = `Hello,\n\nWe supply premium-quality uniforms and would love to support your requirement. Please let us know the sizes and timelines so we can share the best quote.\n\nThanks,\nTeam IndiaMART Agent`;
  
  // State management
  let isAutoContactEnabled = false;
  let isStopped = false;
  let lastContactTime = 0;
  let processedLeads = new Set<string>();
  let pageRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let periodicProcessInterval: ReturnType<typeof setInterval> | null = null;
  let filteredLeadsCount = 0;
  let contactedLeadsCount = 0;
  let pendingContacts: Lead[] = [];
  let hasLoggedNoLeadCards = false;
  let lastRefreshTime = 0;
  let lastProcessingTime = Date.now();
  let isTabVisible = !document.hidden;
  let lastAutoScrollRun = 0;
  let initialScrapeInterval: ReturnType<typeof setInterval> | null = null;
  let isLeadProcessingRunning = false;
  let contactInFlight = false;
  let zeroBalanceDetected = false;
  let zeroBalanceObserver: MutationObserver | null = null;

  const stopAutomationTimers = (): void => {
    if (pageRefreshTimer) {
      clearTimeout(pageRefreshTimer);
      pageRefreshTimer = null;
    }
    if (periodicProcessInterval) {
      clearInterval(periodicProcessInterval);
      periodicProcessInterval = null;
    }
    if (initialScrapeInterval) {
      clearInterval(initialScrapeInterval);
      initialScrapeInterval = null;
    }
  };

  const resetAutomationState = ({ stopped = false }: { stopped?: boolean } = {}): void => {
    stopAutomationTimers();
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

    const script = document.createElement('script');
    script.id = 'ai-contact-click-bridge';
    script.textContent = `
      (() => {
        if (window.__aiContactBridgeInstalled) return;
        window.__aiContactBridgeInstalled = true;

        window.addEventListener('message', (event) => {
          if (!event || event.source !== window) return;
          const data = event.data;
          if (!data || data.type !== 'AI_CONTACT_BRIDGE_CLICK') return;

          const selector = data.selector;
          if (!selector) return;

          const element = document.querySelector(selector);
          if (!element) return;

          try {
            const mouseInit = { bubbles: true, cancelable: true };
            const inline = element.getAttribute('onclick');
            if (inline) {
              const handler = new Function('event', inline);
              handler.call(element, new MouseEvent('click', mouseInit));
              return;
            }
            if (typeof element.onclick === 'function') {
              element.onclick.call(element, new MouseEvent('click', mouseInit));
              return;
            }
            element.dispatchEvent(new MouseEvent('click', mouseInit));
          } catch (error) {
            console.error('[AI Contact Bridge] Failed to execute click handler:', error);
          }
        }, false);
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  };

  const triggerRobustClick = (element: HTMLElement): void => {
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

    ['mousedown', 'mouseup', 'click'].forEach((type) => {
      const evt = new MouseEvent(type, mouseInit);
      element.dispatchEvent(evt);
    });

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
  };

  const clickWithFallback = (element: HTMLElement, label: string): void => {
    console.debug(`[IndiaMART Agent] Triggering ${label} action via robust click.`);
    try {
      triggerRobustClick(element);
    } catch (error) {
      console.error(`[IndiaMART Agent] Robust click failed for ${label}:`, error);
    }

    setTimeout(() => {
      if (!element.isConnected) return;
      try {
        element.click();
        console.debug(`[IndiaMART Agent] Executed fallback click for ${label}.`);
      } catch (error) {
        console.warn(`[IndiaMART Agent] Fallback click failed for ${label}:`, error);
      }
    }, 200);
  };

  const locateContactButton = (card: Element): HTMLElement | null => {
    const selectors = [
      'button',
      'a',
      '.btnCBN',
      '.btnCBN1',
      '[data-action="contact"]',
      '[onclick*="contactbuyernow"]'
    ];

    const contexts = [card, ...getInteractionContexts()];
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
          const label = candidate.textContent?.trim().toLowerCase() || '';
          if (!label.includes('contact buyer')) continue;
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
    const selectors = [
      'button.load-more',
      'button.loadMore',
      'button[data-testid*="load"]',
      'button[data-action*="load"]',
      '[role="button"][aria-label*="Load"]',
      '.loadMoreBtn',
      '.view-more',
      '.showMore',
      'a.load-more',
    ];
    for (const selector of selectors) {
      const btn = document.querySelector<HTMLElement>(selector);
      if (btn && !btn.getAttribute('aria-disabled')) {
        btn.click();
        console.log(`[IndiaMART Agent] Auto-scroll clicked potential load-more button via selector "${selector}".`);
        return true;
      }
    }
    return false;
  };

  const ensureMinimumLeadCards = async (
    minCount = MIN_LEAD_TARGET,
    maxAttempts = AUTO_SCROLL_MAX_ATTEMPTS,
    delayMs = AUTO_SCROLL_DELAY_MS
  ): Promise<void> => {
    const existing = getLeadCardElements().length;
    if (existing >= minCount) {
      return;
    }

    const now = Date.now();
    if (now - lastAutoScrollRun < AUTO_SCROLL_COOLDOWN_MS) {
      return;
    }
    lastAutoScrollRun = now;

    console.log(`[IndiaMART Agent] Auto-scroll: need at least ${minCount} lead cards (currently ${existing}).`);

    let attempt = 0;
    let previousCount = existing;

    while (attempt < maxAttempts) {
      attempt += 1;

      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      const clicked = attemptClickLoadMore();
      if (!clicked) {
        window.scrollTo({ top: document.body.scrollHeight + 500, behavior: 'smooth' });
      }

      await delay(delayMs);

      const currentCount = getLeadCardElements().length;
      console.log(`[IndiaMART Agent] Auto-scroll attempt ${attempt}: ${currentCount}/${minCount} cards found.`);

      if (currentCount >= minCount) {
        break;
      }

      if (currentCount <= previousCount) {
        await delay(delayMs);
      }

      previousCount = currentCount;
    }

    const finalCount = getLeadCardElements().length;
    console.log(`[IndiaMART Agent] Auto-scroll completed after ${attempt} attempts. Total cards available: ${finalCount}.`);
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

    const city =
      sanitizeOptional(card.querySelector('.lstNwLftLoc .city_click')?.textContent) ||
      getInputValue(card, 'input[id^="card_city"], input[name^="card_city"]');
    const state =
      sanitizeOptional(card.querySelector('.lstNwLftLoc .state_click')?.textContent) ||
      getInputValue(card, 'input[id^="card_state"], input[name^="card_state"]');
    const location =
      sanitizeOptional(card.querySelector('li[title="Location"] span, .location')?.textContent) ||
      [city, state].filter(Boolean).join(', ') ||
      'N/A';

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

    const cards = getLeadCardElements();
    const card = cards[cardIndex];
    if (!card) {
      return { success: false, error: `Lead card at index ${cardIndex} not found.` };
    }

    if (card instanceof HTMLElement) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    const contactButton = await waitForElement(() => {
      const button = findElementByText(card, 'button, a', CONTACT_BUTTON_TEXT);
      if (isElementVisible(button)) return button;
      const located = locateContactButton(card);
      return isElementVisible(located) ? located : null;
    }, 8000);

    if (shouldAbort()) {
      console.info('[IndiaMART Agent] Contact flow aborted after locating contact button (auto-contact disabled or agent stopped).');
      return { success: false, error: 'Auto-contact disabled.' };
    }

    if (!contactButton) {
      console.warn('[IndiaMART Agent] Contact button could not be located for card index:', cardIndex, lead?.companyName);
      return { success: false, error: 'Contact Buyer Now button not found.' };
    }

    console.debug('[IndiaMART Agent] Contact button located, preparing to submit contact flow.');
    console.debug('[IndiaMART Agent] Clicking Contact Buyer button for lead:', lead?.companyName || cardIndex);
    clickWithFallback(contactButton, 'Contact Buyer');
    console.info('[IndiaMART Agent] Clicked Contact Buyer button for lead:', lead?.companyName || cardIndex);

    // Attempt to fill the message while the form loads
    const desiredMessage = composeContactMessage(lead);
    let messageFilled = fillContactMessage(desiredMessage);

    const replyButton = await waitForElement(() => {
      if (!messageFilled) {
        messageFilled = fillContactMessage(desiredMessage);
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
      return isElementVisible(fallbackButton) ? fallbackButton : null;
    }, 20000);

    if (shouldAbort()) {
      console.info('[IndiaMART Agent] Contact flow aborted before Send Reply (auto-contact disabled or agent stopped).');
      return { success: false, error: 'Auto-contact disabled.' };
    }

    if (!replyButton) {
      return { success: false, error: 'Send Reply button not found after opening contact form.' };
    }

    if (!messageFilled) {
      // Try one last time before sending
      messageFilled = fillContactMessage(desiredMessage);
      if (!messageFilled) {
        console.warn('[IndiaMART Agent] Could not locate a message field before sending reply. Proceeding with default behaviour.');
      }
    }

    // Ensure button is in view before clicking
    replyButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
    console.debug('[IndiaMART Agent] Clicking Send Reply button.');

    if (shouldAbort()) {
      console.info('[IndiaMART Agent] Contact flow aborted before clicking Send Reply (auto-contact disabled or agent stopped).');
      return { success: false, error: 'Auto-contact disabled.' };
    }

    clickWithFallback(replyButton, 'Send Reply');

    // Give the site a moment to register the submission
    await delay(1200);

    let sendConfirmed = await waitForSendReplyConfirmation(6000);

    if (shouldAbort()) {
      console.info('[IndiaMART Agent] Contact flow aborted while waiting for confirmation (auto-contact disabled or agent stopped).');
      return { success: false, error: 'Auto-contact disabled.' };
    }

    if (!sendConfirmed) {
      console.warn('[IndiaMART Agent] Send Reply confirmation not detected after first attempt; retrying click.');
      const retryButton =
        (replyButton.isConnected && isElementVisible(replyButton)) ?
          replyButton :
          await waitForElement(() => {
            const candidate = findSendReplyButton();
            return isElementVisible(candidate) ? candidate : null;
          }, 5000);

      if (retryButton) {
        if (shouldAbort()) {
          console.info('[IndiaMART Agent] Contact flow aborted before retrying Send Reply (auto-contact disabled or agent stopped).');
          return { success: false, error: 'Auto-contact disabled.' };
        }

        console.debug('[IndiaMART Agent] Retrying Send Reply with fallback click support.');
        clickWithFallback(retryButton, 'Send Reply Retry');
        await delay(1500);
        sendConfirmed = await waitForSendReplyConfirmation(6000);
      } else {
        console.warn('[IndiaMART Agent] Could not locate Send Reply button for retry attempt.');
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

  const enquiryKeywords = [
    'uniform', 'uniform fabric', 'uniform blazers', 'uniform jackets', 'school jackets', 'nurse uniform',
    'chef coats', 'corporate uniform', 'staff uniform', 'ncc uniform', 'waiter uniform',
    'kids school uniform', 'school uniforms', 'school blazers', 'school blazer', 'school uniform fabric',
    'worker uniform', 'security guard uniform', 'petrol pump uniform', 'safety suits',
    'boys school uniform', 'surgical gown', 'hospital uniforms'
  ];
  const foreignIndicators = ['usa', 'uk', 'uae', 'canada', 'australia', 'singapore', 'malaysia'];
  const quantityThreshold = { min: 100, unit: 'piece' };
  const allowedCategories = [
    'kids school uniform', 'kids school uniforms', 'school uniforms', 'school blazers', 'school blazer', 'school uniform fabric',
    'worker uniform', 'uniform fabric', 'security guard uniform', 'petrol pump uniform',
    'safety suits', 'boys school uniform', 'surgical gown', 'hospital uniforms', 'corporate uniform', 'school college uniforms',
    'school jackets'
  ];
  const orderValueMin = 50000;

  const getFilterCriteria = () => ({
    keywords: enquiryKeywords,
    foreignIndicators,
    quantity: quantityThreshold,
    orderValueMin,
    categories: allowedCategories,
  });

  const applyIntelligentFilter = (lead: Lead): { passed: boolean; reason: string; nextContactDelayMinutes: number } => {
    // Filter 1: Enquiry Title Keywords (inclusive match)
    const titleLower = (lead.enquiryTitle || lead.requirement || '').toLowerCase();
    const hasKeyword = enquiryKeywords.some(keyword => titleLower.includes(keyword));
    if (!hasKeyword) return { passed: false, reason: 'No uniform keywords found', nextContactDelayMinutes: 0 };
    
    // Filter 2: Location exclusion
    const locationLower = (lead.location || '').toLowerCase();
    
    // Check for foreign locations (reject if any foreign indicator is present)
    const isForeign = foreignIndicators.some(country => locationLower.includes(country));
    if (isForeign) return { passed: false, reason: 'Foreign location', nextContactDelayMinutes: 0 };
    
    // Filter 3: Quantity > 100
    const quantityUnitOk =
      typeof lead.quantity === 'number' &&
      lead.quantity >= quantityThreshold.min &&
      typeof lead.quantityRaw === 'string' &&
      lead.quantityRaw.toLowerCase().includes(quantityThreshold.unit);
    if (!quantityUnitOk) {
      return {
        passed: false,
        reason: `Quantity must be ≥ ${quantityThreshold.min} ${quantityThreshold.unit.charAt(0).toUpperCase()}${quantityThreshold.unit.slice(1)}`,
        nextContactDelayMinutes: 0
      };
    }
    
    // Filter 4: Category match (exact match)
    const categoryLower = (lead.category || '').toLowerCase();
    const hasCategory = allowedCategories.some((keyword) => {
      const normalized = keyword.toLowerCase();
      return categoryLower.includes(normalized) || normalized.includes(categoryLower);
    });
    if (!hasCategory && lead.category) {
      return { passed: false, reason: 'Category not in allowed list', nextContactDelayMinutes: 0 };
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

  const setupPageRefresh = (immediate = false) => {
    if (isStopped || !isAutoContactEnabled) {
      return;
    }

    if (pageRefreshTimer) {
      clearTimeout(pageRefreshTimer);
      pageRefreshTimer = null;
    }
    
    // Calculate delay - always enforce minimum 30 second gap between refreshes
    const timeSinceLastRefresh = Date.now() - lastRefreshTime;
    const minRefreshGap = REFRESH_INTERVAL;
    
    let refreshDelay: number;
    if (immediate) {
      // Even for "immediate" refresh, ensure at least 30 seconds have passed
      refreshDelay = Math.max(0, minRefreshGap - timeSinceLastRefresh);
    } else {
      // For regular refresh, always use 30 seconds
      refreshDelay = REFRESH_INTERVAL;
    }
    
    // If a refresh was just done, ensure we wait the full interval
    if (timeSinceLastRefresh > 0 && timeSinceLastRefresh < minRefreshGap) {
      refreshDelay = minRefreshGap - timeSinceLastRefresh;
    }
    
    console.log(`[IndiaMART Agent] Scheduling page refresh in ${(refreshDelay / 1000).toFixed(1)} seconds`);
    
    pageRefreshTimer = setTimeout(() => {
      if (!isStopped && isAutoContactEnabled) {
        lastRefreshTime = Date.now();
        console.log('IndiaMART Agent: Refreshing page...');
        window.location.reload();
      }
    }, refreshDelay);
  };
  
  // Setup periodic processing every 30 seconds to save logs regularly
  const setupPeriodicProcessing = () => {
    if (isStopped || !isAutoContactEnabled) {
      return;
    }
    
    // Clear any existing interval to avoid duplicates
    if (periodicProcessInterval) {
      clearInterval(periodicProcessInterval);
      periodicProcessInterval = null;
    }
    
    // Process leads every 30 seconds to ensure logs are saved regularly
    console.log('[IndiaMART Agent] Setting up periodic processing - will process and save logs every 30 seconds');
    periodicProcessInterval = setInterval(() => {
      if (!isStopped && isAutoContactEnabled) {
        const timeSinceLastProcessing = Date.now() - lastProcessingTime;
        if (timeSinceLastProcessing >= REFRESH_INTERVAL - 5000) { // Process if 25+ seconds have passed
          console.log('[IndiaMART Agent] Periodic processing - processing leads and saving logs (runs regardless of tab visibility)...');
          processLeadsWithFiltering();
        }
      }
    }, REFRESH_INTERVAL);
  };

  // Setup automatic refresh every 30 seconds when auto-contact is enabled
  const setupPeriodicRefresh = () => {
    if (isStopped || !isAutoContactEnabled) {
      return;
    }
    
    // Clear any existing timer to avoid duplicates
    if (pageRefreshTimer) {
      clearTimeout(pageRefreshTimer);
      pageRefreshTimer = null;
    }
    
    // Schedule refresh in 30 seconds
    console.log('[IndiaMART Agent] Setting up periodic refresh - will refresh in 30 seconds');
    pageRefreshTimer = setTimeout(() => {
      if (!isStopped && isAutoContactEnabled) {
        lastRefreshTime = Date.now();
        console.log('IndiaMART Agent: Periodic refresh - refreshing page now...');
        window.location.reload();
      }
    }, REFRESH_INTERVAL);
  };

  const processFilteredLead = async (lead: Lead, cardIndex: number): Promise<boolean> => {
    if (!isAutoContactEnabled || isStopped) return false;
    
    return withContactLock(async () => {
      try {
        const result = await performContactFlow(cardIndex, lead);
        if (result.success) {
          processedLeads.add(lead.leadId);
          lastContactTime = Date.now();
          contactedLeadsCount++;
          
          chrome.runtime.sendMessage({
            type: 'AUTO_CONTACT_SUCCESS',
            leadId: lead.leadId,
            companyName: lead.companyName,
            timestamp: new Date().toISOString(),
            contactedCount: contactedLeadsCount,
            totalFiltered: filteredLeadsCount,
            tabHidden: document.hidden
          });
          
          console.log(`Contacted: ${lead.companyName} (${contactedLeadsCount}/${filteredLeadsCount})`);
          
          // Check if all filtered leads have been contacted
          if (contactedLeadsCount >= filteredLeadsCount && isAutoContactEnabled && !isStopped) {
            console.log('All filtered leads contacted. Periodic refresh will handle page refresh.');
            // Don't trigger immediate refresh - let periodic refresh handle it in 30 seconds
          }
          
          return true;
        }
      } catch (error) {
        console.error('Error contacting lead:', error);
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
  const MAX_CONTACT_SUCCESS = 50; // keep last N successful contacts
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
    evaluations: LeadEvaluation[]
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
        }))
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
      
      if (filteredLeads.length > 0) {
        logEntries.push(`[${timestamp}] [IndiaMART Agent] Filtered leads list:`);
        filteredLeads.forEach((lead, index) => {
          logEntries.push(`[${timestamp}] [IndiaMART Agent]   ${index + 1}. Company: ${lead.companyName}, Enquiry: ${lead.enquiryTitle}, Location: ${lead.location}`);
        });
      } else {
        logEntries.push(`[${timestamp}] [IndiaMART Agent] Filtered leads list: Array(0)`);
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
    
    if (isLeadProcessingRunning) {
      lastProcessingTime = Date.now();
      console.debug('[IndiaMART Agent] Skipping processLeadsWithFiltering - already running.');
      return;
    }
    
    isLeadProcessingRunning = true;
    lastProcessingTime = Date.now();
    
    try {
      await ensureMinimumLeadCards(MIN_LEAD_TARGET);
      const leads = scrapeLeads();
      const filteredLeads: Lead[] = [];
      const leadEvaluations: LeadEvaluation[] = [];
      const contactsToProcess: Lead[] = [];
      
      // Reset counters for this batch
      filteredLeadsCount = 0;
      contactedLeadsCount = 0;
      pendingContacts = [];
      
      console.log('[IndiaMART Agent] Processing leads with filtering...');
      console.log('[IndiaMART Agent] Total leads to process:', leads.length);
      
      // Apply filtering
      for (const lead of leads) {
        if (processedLeads.has(lead.leadId)) {
          console.log(`[IndiaMART Agent] Skipping already processed lead: ${lead.companyName}`);
          continue; // Skip already processed
        }
        
        const filterResult = applyIntelligentFilter(lead);
        lead.passedFilter = filterResult.passed;
        lead.filterReason = filterResult.reason;
        lead.nextContactDelayMinutes = filterResult.nextContactDelayMinutes;
        leadEvaluations.push({ lead, passed: filterResult.passed, reason: filterResult.reason });
        
        console.log(`[IndiaMART Agent] Lead: ${lead.companyName}`);
        console.log(`  - Filter passed: ${filterResult.passed}`);
        console.log(`  - Reason: ${filterResult.reason}`);
        console.log(`  - Details:`, {
          enquiryTitle: lead.enquiryTitle,
          location: lead.location,
          quantity: lead.quantity,
          category: lead.category,
          orderValue: `₹${lead.probableOrderValueMin || 0} - ₹${lead.probableOrderValueMax || 0}`
        });
        
        if (filterResult.passed) {
          filteredLeads.push(lead);
          contactsToProcess.push(lead);
          pendingContacts.push(lead);
          filteredLeadsCount++;
        }
      }
      
      // Send filtered data to popup
      chrome.runtime.sendMessage({
        type: 'FILTERED_LEADS_DATA',
        payload: {
          allLeads: leads,
          filteredLeads: filteredLeads,
        autoContactEnabled: isAutoContactEnabled,
        filters: getFilterCriteria()
        }
      });
      
      console.log('[IndiaMART Agent] ========== FILTERING SUMMARY ==========');
      console.log(`[IndiaMART Agent] Total leads: ${leads.length}`);
      console.log(`[IndiaMART Agent] Filtered (qualified) leads: ${filteredLeadsCount}`);
      console.log(`[IndiaMART Agent] Rejected leads: ${leads.length - filteredLeadsCount}`);
      console.log('[IndiaMART Agent] Filtered leads list:', filteredLeads.map(l => ({
        company: l.companyName,
        enquiry: l.enquiryTitle,
        location: l.location
      })));
      
      // Save filtering summary to Chrome storage
      await saveFilteringSummaryToStorage(
        leads.length,
        filteredLeadsCount,
        leads.length - filteredLeadsCount,
        filteredLeads,
        leadEvaluations
      );
      
      // Notify popup/background that logs were updated
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ type: 'LOGS_UPDATED' });
        }
      } catch {}
      
      // Only schedule refresh + periodic processing when auto-contact is active
      if (isAutoContactEnabled && !isStopped) {
        setupPeriodicRefresh(); // Refresh page every 30 seconds while auto-contact runs
        setupPeriodicProcessing(); // Process and save logs every 30 seconds
      }
      
      // Decide on refresh strategy for specific cases
      if (filteredLeadsCount === 0) {
        if (isAutoContactEnabled && !isStopped) {
          console.log('No filtered leads found. Periodic refresh already scheduled.');
        } else {
          console.log('No filtered leads found. Auto-contact disabled, no refresh scheduled.');
        }
      } else if (isAutoContactEnabled && !isStopped) {
        for (const lead of contactsToProcess) {
          if (isStopped || !isAutoContactEnabled) {
            break;
          }
          const contacted = await processFilteredLead(lead, lead.cardIndex || 0);
          if (contacted && typeof lead.nextContactDelayMinutes === 'number' && lead.nextContactDelayMinutes > 0) {
            await delay(lead.nextContactDelayMinutes * 60 * 1000);
          }
        }
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
      resetAutomationState({ stopped: false });
      sendResponse({ success: true });
      return true;
    }
    
    if (message.type === 'STOP_AGENT') {
      resetAutomationState({ stopped: true });
      console.log('Agent stopped by user');
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
  
  startZeroBalanceObserver();
  syncAutoContactState();
})(); // End of IIFE
