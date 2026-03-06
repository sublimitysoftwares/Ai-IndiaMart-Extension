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

export const parseQuantity = (value?: string | null): { raw?: string; quantity?: number } => {
  if (!value) return {};
  const raw = sanitize(value);
  const digits = raw.replace(/[^0-9.]/g, '');
  const quantity = digits ? Number(digits) : undefined;
  return {
    raw,
    quantity: typeof quantity === 'number' && Number.isFinite(quantity) ? quantity : undefined,
  };
};

export const parseRupeeRange = (value?: string | null): { raw?: string; min?: number; max?: number } => {
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
    .map((token) => {
      const num = Number(token);
      // Only apply lakh/crore scale to small numbers (< 1000).
      // Numbers like 80,000 are already in full form and should NOT be scaled.
      // Numbers like 1.5 or 80 are in lakh/crore notation and need scaling.
      if (scale > 1 && num < 1000) {
        return num * scale;
      }
      return num;
    })
    .filter((num) => Number.isFinite(num));

  if (numbers.length === 0) {
    return { raw };
  }

  const min = numbers[0];
  const max = numbers.length > 1 ? numbers[numbers.length - 1] : numbers[0];
  return { raw, min, max };
};