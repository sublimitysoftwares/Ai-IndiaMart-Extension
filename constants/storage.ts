// Storage keys used across the extension

export const STORAGE_KEYS = {
  FILTER_KEYWORDS: 'indiamart_filter_keywords',
  FILTER_CATEGORIES: 'indiamart_filter_categories',
  FILTER_QUANTITY: 'indiamart_filter_quantity',
  FILTER_ORDER_VALUE: 'indiamart_filter_order_value',
  SKIPPED_LEADS: 'indiamart_skipped_leads',
  BUY_LEAD_SUSPENSION: 'indiamart_buylead_suspension',
  DAILY_CONTACT_STATS: 'indiamart_daily_contact_stats',
  LEADS_CACHE: 'indiamart_leads_cache',
  FILTERED_LEADS_CACHE: 'indiamart_filtered_leads_cache',
  CONTACTED_LEADS_CACHE: 'indiamart_contacted_leads_cache',
  PASSED_LEADS_LOG: 'indiamart_passed_leads_log',
  REJECTED_LEADS_LOG: 'indiamart_rejected_leads_log',
  AGENT_STATE: 'indiamart_agent_state',
} as const;

// Legacy aliases for backward compatibility
export const FILTER_KEYWORDS_KEY = STORAGE_KEYS.FILTER_KEYWORDS;
export const FILTER_CATEGORIES_KEY = STORAGE_KEYS.FILTER_CATEGORIES;
export const FILTER_QUANTITY_KEY = STORAGE_KEYS.FILTER_QUANTITY;
export const FILTER_ORDER_VALUE_KEY = STORAGE_KEYS.FILTER_ORDER_VALUE;
export const SKIPPED_LEADS_KEY = STORAGE_KEYS.SKIPPED_LEADS;
export const BUY_LEAD_SUSPENSION_KEY = STORAGE_KEYS.BUY_LEAD_SUSPENSION;
export const DAILY_CONTACT_STATS_KEY = STORAGE_KEYS.DAILY_CONTACT_STATS;
export const AGENT_STATE = STORAGE_KEYS.AGENT_STATE;