// DOM manipulation utilities

export const getInteractionContexts = (): (Document | ShadowRoot)[] => {
  const contexts: (Document | ShadowRoot)[] = [document];
  const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'));
  iframes.forEach((frame) => {
    try {
      const doc = frame.contentDocument;
      if (doc) {
        contexts.push(doc);
      }
    } catch (error) {
      // Cross-origin iframe, skip
    }
  });
  return contexts;
};

export const isElementVisible = (element: HTMLElement | null | undefined): element is HTMLElement => {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

export const setElementValue = (element: HTMLElement, value: string): void => {
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

export const findElementByText = (
  context: Document | ShadowRoot | HTMLElement,
  selector: string,
  text: string
): HTMLElement | null => {
  const elements = context.querySelectorAll<HTMLElement>(selector);
  const lowerText = text.toLowerCase();
  for (const el of elements) {
    const content = (el.textContent || '').toLowerCase();
    if (content.includes(lowerText)) {
      return el;
    }
  }
  return null;
};

export const waitForElement = async (
  finder: () => HTMLElement | null,
  timeoutMs: number,
  intervalMs: number = 250
): Promise<HTMLElement | null> => {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const element = finder();
    if (element) {
      return element;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
};