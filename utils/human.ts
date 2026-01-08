// Human-like behavior simulation utilities

import { randomBetween, delay } from './time';
import {
  MOUSE_MOVE_DELAY_MIN_MS,
  MOUSE_MOVE_DELAY_MAX_MS,
  HOVER_DELAY_MIN_MS,
  HOVER_DELAY_MAX_MS,
  POST_CLICK_DELAY_MIN_MS,
  POST_CLICK_DELAY_MAX_MS,
  READING_DELAY_MIN_MS,
  READING_DELAY_MAX_MS,
  PROMISING_READING_DELAY_MIN_MS,
  PROMISING_READING_DELAY_MAX_MS,
} from '../constants/timing';
import { randomIntBetween } from './time';

export const simulateMouseMove = (element?: HTMLElement): void => {
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

export const simulateHoverDelay = async (element: HTMLElement): Promise<void> => {
  const passes = randomIntBetween(2, 4);
  for (let i = 0; i < passes; i++) {
    simulateMouseMove(element);
    await delay(randomBetween(MOUSE_MOVE_DELAY_MIN_MS, MOUSE_MOVE_DELAY_MAX_MS));
  }
  await delay(randomBetween(HOVER_DELAY_MIN_MS, HOVER_DELAY_MAX_MS));
};

export const simulatePostClickMovement = async (element?: HTMLElement): Promise<void> => {
  await delay(randomBetween(POST_CLICK_DELAY_MIN_MS, POST_CLICK_DELAY_MAX_MS));
  simulateMouseMove(element);
  await delay(randomBetween(120, 300));
  simulateMouseMove();
};

export const humanScrollBy = async (distance: number): Promise<void> => {
  window.scrollBy({ top: distance, behavior: 'auto' });
  simulateMouseMove();
  await delay(500); // Fixed 500ms delay for consistent 1 second per lead timing
};

export const performHumanScrollPass = async (): Promise<void> => {
  // 1 second per lead scrolling - much larger distances to ensure reaching 50 leads
  const distance = randomBetween(700, 1000); // Much larger scroll distance to cover more ground efficiently
  await humanScrollBy(distance);
  await delay(500); // Fixed 500ms delay to maintain 1 second per lead
};

export const applyReadingDelay = async (
  leadTitle: string,
  enquiryKeywords: string[]
): Promise<void> => {
  const title = (leadTitle || '').toLowerCase();
  const isPromising = enquiryKeywords.some((keyword) => title.includes(keyword.toLowerCase()));
  const min = isPromising ? PROMISING_READING_DELAY_MIN_MS : READING_DELAY_MIN_MS;
  const max = isPromising ? PROMISING_READING_DELAY_MAX_MS : READING_DELAY_MAX_MS;
  const waitMs = randomBetween(min, max);
  await delay(waitMs);
};

export const pickRandomSkipIndexes = (total: number): Set<number> => {
  const skipCount = total <= 3 ? randomIntBetween(0, 1) : randomIntBetween(1, 2);
  const indexes = new Set<number>();
  while (indexes.size < skipCount) {
    const index = randomIntBetween(0, Math.max(0, total - 1));
    indexes.add(index);
    if (indexes.size >= total) break;
  }
  return indexes;
};