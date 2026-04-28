// Timing and delay constants

export const SCRAPE_INTERVAL_MS = 1000;
export const SCRAPE_MAX_ATTEMPTS = 15;

export const WORKING_HOURS = { start: 9, end: 21 }; // 9 AM – 9 PM
export const WORKING_REFRESH_RANGE_MINUTES = { min: 5, max: 15 };
export const OFF_HOURS_REFRESH_RANGE_MINUTES = { min: 65, max: 90 };

export const MIN_LEAD_TARGET = 75;
export const AUTO_SCROLL_MAX_ATTEMPTS = 500;
export const AUTO_SCROLL_DELAY_MS = 1000; // 1 second per lead
export const AUTO_SCROLL_COOLDOWN_MS = 5 * 1000; // 5 seconds
export const MAX_SCROLL_TIME_MS = 300000; // 5 minute timeout

export const BACKOFF_ERROR_THRESHOLD = 3;
export const BACKOFF_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
export const BACKOFF_MIN_DELAY_MS = 5 * 60 * 1000;
export const BACKOFF_MAX_DELAY_MS = 10 * 60 * 1000;

export const REFRESH_DELAY_SECONDS = 30; // Fixed 30 second refresh interval

export const RESUME_ALARM_NAME = 'resumeAutoContact';

// Human behavior delays
export const HOVER_DELAY_MIN_MS = 400;
export const HOVER_DELAY_MAX_MS = 1200;
export const MOUSE_MOVE_DELAY_MIN_MS = 80;
export const MOUSE_MOVE_DELAY_MAX_MS = 180;
export const POST_CLICK_DELAY_MIN_MS = 200;
export const POST_CLICK_DELAY_MAX_MS = 600;
export const READING_DELAY_MIN_MS = 1000;
export const READING_DELAY_MAX_MS = 3000;
export const PROMISING_READING_DELAY_MIN_MS = 2000;
export const PROMISING_READING_DELAY_MAX_MS = 5000;

export const CONTACT_HISTORY_RETENTION_MS = 10 * 24 * 60 * 60 * 1000; // 10 days