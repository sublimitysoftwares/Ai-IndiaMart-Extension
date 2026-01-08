// Text processing and sanitization utilities

export const sanitize = (value?: string | null): string => (value || '').trim();

export const sanitizeOptional = (value?: string | null): string | undefined => {
  const cleaned = sanitize(value);
  return cleaned || undefined;
};

export const sanitizeKeyword = (keyword: string): string => {
  return keyword.trim().toLowerCase();
};

export const validateKeyword = (keyword: string): boolean => {
  const trimmed = keyword.trim();
  return trimmed.length > 0 && trimmed.length <= 100;
};