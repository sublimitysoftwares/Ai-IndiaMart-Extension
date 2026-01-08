// Validation utility functions

import { validateKeyword, sanitizeKeyword } from './text';

export { validateKeyword, sanitizeKeyword };

export const validateQuantity = (value: number): boolean => {
  return value >= 1 && value <= 1000000;
};

export const validateOrderValue = (value: number): boolean => {
  return value >= 0 && value <= 100000000;
};