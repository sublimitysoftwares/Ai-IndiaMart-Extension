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
  const SCRAPE_INTERVAL_MS = 1000;
  const SCRAPE_MAX_ATTEMPTS = 15;
  const REFRESH_INTERVAL = 30 * 1000; // 30 seconds
  const MIN_CONTACT_DELAY = 10 * 1000; // 10 seconds
  const MAX_CONTACT_DELAY = 5 * 60 * 1000; // 5 minutes
  const CONTACT_REPLY_DELAY_MIN = 4 * 60 * 1000; // 4 minutes
  const CONTACT_REPLY_DELAY_MAX = 6 * 60 * 1000; // 6 minutes
  const MAX_CONTACT_GAP = 15 * 60 * 1000; // 15 minutes
  
  // State management
  let isAutoContactEnabled = false;
  let isStopped = false;
  let lastContactTime = 0;
  let processedLeads = new Set<string>();
  let pageRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let filteredLeadsCount = 0;
  let contactedLeadsCount = 0;
  let pendingContacts: Lead[] = [];
  let hasLoggedNoLeadCards = false;
  let lastRefreshTime = 0;

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

        if (!previousState && isAutoContactEnabled && !isStopped) {
          console.log('Auto-contact restored from background state. Setting up periodic refresh.');
          setupPeriodicRefresh();
        } else if (isAutoContactEnabled && !isStopped) {
          // If auto-contact is already enabled, set up periodic refresh
          setupPeriodicRefresh();
        }
      }
    });
  };

  const sanitize = (value?: string | null): string => (value || '').trim();
  const sanitizeOptional = (value?: string | null): string | undefined => {
    const cleaned = sanitize(value);
    return cleaned || undefined;
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
    const cleaned = raw.replace(/[^0-9.,-]/g, '');
    const parts = cleaned
      .split(/[-–]/)
      .map((part) => Number(part.replace(/[,]/g, '')))
      .filter((num) => !Number.isNaN(num));
    const min = parts[0];
    const max = parts.length > 1 ? parts[1] : parts[0];
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

  const performContactFlow = async (cardIndex: number): Promise<{ success: boolean; error?: string }> => {
    const cards = getLeadCardElements();
    const card = cards[cardIndex];
    if (!card) {
      return { success: false, error: `Lead card at index ${cardIndex} not found.` };
    }

    const contactButton = await waitForElement(() => findElementByText(card, 'button, a', CONTACT_BUTTON_TEXT), 5000);
    if (!contactButton) {
      return { success: false, error: 'Contact Buyer Now button not found.' };
    }
    contactButton.click();

    const replyButton = await waitForElement(() => {
      const directMatch = document.querySelector<HTMLElement>(SEND_REPLY_SELECTOR);
      if (directMatch && directMatch.textContent?.trim().toLowerCase() === SEND_REPLY_TEXT.toLowerCase()) {
        return directMatch;
      }
      return findElementByText(document, 'button, a, div', SEND_REPLY_TEXT);
    }, 8000);
    if (!replyButton) {
      return { success: false, error: 'Send Reply button not found after opening contact form.' };
    }

    const replyDelay =
      CONTACT_REPLY_DELAY_MIN + Math.random() * (CONTACT_REPLY_DELAY_MAX - CONTACT_REPLY_DELAY_MIN);
    console.log(
      `[IndiaMART Agent] Waiting ${(replyDelay / 60000).toFixed(2)} minutes before sending reply...`
    );
    await new Promise((resolve) => setTimeout(resolve, replyDelay));

    if (isStopped || !isAutoContactEnabled) {
      return { success: false, error: 'Agent stopped or auto-contact disabled before sending reply.' };
    }

    replyButton.click();

    return { success: true };
  };

  // Removed duplicate startScrapeLoop - defined later in the file

  const applyIntelligentFilter = (lead: Lead): { passed: boolean; reason: string; nextContactDelayMinutes: number } => {
    // Filter 1: Enquiry Title Keywords (inclusive match)
    const enquiryKeywords = [
      'uniform', 'uniform fabric', 'uniform blazers', 'uniform jackets', 'nurse uniform',
      'chef coats', 'corporate uniform', 'staff uniform', 'ncc uniform', 'waiter uniform'
    ];
    const titleLower = (lead.enquiryTitle || lead.requirement || '').toLowerCase();
    const hasKeyword = enquiryKeywords.some(keyword => titleLower.includes(keyword));
    if (!hasKeyword) return { passed: false, reason: 'No uniform keywords found', nextContactDelayMinutes: 0 };
    
    // Filter 2: Location exclusion
    const excludedLocations = [
      'delhi', 'mumbai', 'gurgaon', 'ahmedabad', 'surat', 'thane'
    ];
    const locationLower = (lead.location || '').toLowerCase();
    const isExcluded = excludedLocations.some(loc => locationLower.includes(loc));
    if (isExcluded) return { passed: false, reason: 'Location is excluded', nextContactDelayMinutes: 0 };
    
    // Check for foreign locations
    const foreignIndicators = ['usa', 'uk', 'uae', 'canada', 'australia', 'singapore', 'malaysia'];
    const isForeign = foreignIndicators.some(country => locationLower.includes(country));
    if (isForeign) return { passed: false, reason: 'Foreign location', nextContactDelayMinutes: 0 };
    
    // Filter 3: Quantity > 100
    if (!lead.quantity || lead.quantity <= 100) {
      return { passed: false, reason: 'Quantity <= 100', nextContactDelayMinutes: 0 };
    }
    
    // Filter 4: Category match (exact match)
    const allowedCategories = [
      'kids school uniform', 'school uniforms', 'school blazers', 'school uniform fabric',
      'worker uniform', 'uniform fabric', 'security guard uniform', 'petrol pump uniform',
      'safety suits', 'boys school uniform', 'surgical gown', 'hospital uniforms', 'corporate uniform'
    ];
    const categoryLower = (lead.category || '').toLowerCase();
    const hasCategory = allowedCategories.some(cat => categoryLower === cat);
    if (!hasCategory && lead.category) {
      return { passed: false, reason: 'Category not in allowed list', nextContactDelayMinutes: 0 };
    }
    
    // Filter 5: Probable Order Value > ₹50,000
    const orderValue = lead.probableOrderValueMin || lead.probableOrderValueMax || 0;
    if (orderValue <= 50000) {
      return { passed: false, reason: 'Order value <= ₹50,000', nextContactDelayMinutes: 0 };
    }
    
    // Generate random delay between 1-10 minutes for qualified leads
    const delayOptions = [1, 5, 10];
    const randomDelay = delayOptions[Math.floor(Math.random() * delayOptions.length)];
    
    return { passed: true, reason: 'Meets all criteria', nextContactDelayMinutes: randomDelay };
  };

  const getRandomDelay = (): number => {
    return MIN_CONTACT_DELAY + Math.random() * (MAX_CONTACT_DELAY - MIN_CONTACT_DELAY);
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
    
    try {
      const result = await performContactFlow(cardIndex);
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
          totalFiltered: filteredLeadsCount
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
  };

  // Storage helper functions for readable log storage
  const STORAGE_KEY = 'indiamart_logs';
  const MAX_LOG_LINES = 1000; // Maximum number of log lines to keep

  const saveFilteringSummaryToStorage = async (
    totalLeads: number,
    filteredLeadsCount: number,
    rejectedLeads: number,
    filteredLeads: Lead[]
  ): Promise<void> => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      console.warn('[IndiaMART Agent] Chrome storage API not available');
      return;
    }

    try {
      const timestamp = new Date().toISOString();
      const dateStr = new Date().toLocaleString();
      
      // Get existing logs
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const existingLogs: string = result[STORAGE_KEY] || '';

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

      // Combine new logs with existing logs
      const newLogs = logEntries.join('\n');
      const combinedLogs = existingLogs + '\n' + newLogs;

      // Split into lines and keep only last MAX_LOG_LINES
      const logLines = combinedLogs.split('\n');
      const trimmedLogs = logLines.slice(-MAX_LOG_LINES).join('\n');

      // Save to storage
      await chrome.storage.local.set({ [STORAGE_KEY]: trimmedLogs });
      console.log('[IndiaMART Agent] Filtering summary logs saved to Chrome storage');
    } catch (error) {
      console.error('[IndiaMART Agent] Error saving filtering summary logs to storage:', error);
    }
  };

  const processLeadsWithFiltering = async () => {
    if (isStopped) return;
    
    const leads = scrapeLeads();
    const filteredLeads: Lead[] = [];
    
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
        autoContactEnabled: isAutoContactEnabled
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
      filteredLeads
    );
    
    // Set up periodic refresh every 30 seconds when auto-contact is enabled
    if (isAutoContactEnabled && !isStopped) {
      setupPeriodicRefresh();
    }
    
    // Decide on refresh strategy for specific cases
    if (filteredLeadsCount === 0) {
      if (isAutoContactEnabled && !isStopped) {
        console.log('No filtered leads found. Periodic refresh already scheduled.');
      } else {
        console.log('No filtered leads found. Auto-contact disabled, no refresh scheduled.');
      }
    } else if (isAutoContactEnabled && !isStopped) {
      // Process contacts with proper timing
      for (let i = 0; i < pendingContacts.length; i++) {
        const lead = pendingContacts[i];
        const timeSinceLastContact = Date.now() - lastContactTime;
        
        // Calculate delay
        let delay: number;
        if (lastContactTime === 0 || timeSinceLastContact > MAX_CONTACT_GAP) {
          delay = 0; // Contact immediately
        } else {
          delay = getRandomDelay();
        }
        
        setTimeout(() => {
          if (!isStopped) {
            processFilteredLead(lead, lead.cardIndex || 0);
          }
        }, delay + (i * 1000)); // Add extra spacing between scheduled contacts
      }
    }
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'SCRAPE_NOW') {
      sendResponse({ leads: scrapeLeads() });
      return true;
    }

    if (message.type === 'CONTACT_LEAD') {
      const { cardIndex } = message;
      performContactFlow(cardIndex)
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
      isAutoContactEnabled = true;
      isStopped = false;
      setupPeriodicRefresh(); // Set up periodic refresh
      processLeadsWithFiltering();
      sendResponse({ success: true });
      return true;
    }
    
    if (message.type === 'DISABLE_AUTO_CONTACT') {
      isAutoContactEnabled = false;
      if (pageRefreshTimer) {
        clearTimeout(pageRefreshTimer);
        pageRefreshTimer = null;
      }
      sendResponse({ success: true });
      return true;
    }
    
    if (message.type === 'STOP_AGENT') {
      isStopped = true;
      isAutoContactEnabled = false;
      if (pageRefreshTimer) {
        clearTimeout(pageRefreshTimer);
        pageRefreshTimer = null;
      }
      console.log('Agent stopped by user');
      sendResponse({ success: true });
      return true;
    }
    
    if (message.type === 'SCRAPE_AND_FILTER') {
      processLeadsWithFiltering();
      sendResponse({ success: true });
      return true;
    }
  });

  // Initial scraping
  const startScrapeLoop = () => {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      const leads = scrapeLeads();
      if (leads.length > 0) {
        clearInterval(interval);
        chrome.runtime.sendMessage({ type: 'LEADS_DATA', payload: leads });
        // Also run filtering
        processLeadsWithFiltering();
      } else if (attempts >= SCRAPE_MAX_ATTEMPTS) {
        clearInterval(interval);
        chrome.runtime.sendMessage({
          type: 'SCRAPING_ERROR',
          error: 'Could not find any leads on the page. Please ensure they are visible.',
        });
      }
    }, SCRAPE_INTERVAL_MS);
  };
  
  syncAutoContactState();
  startScrapeLoop();
})(); // End of IIFE
