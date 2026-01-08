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
  context: Document | ShadowRoot | HTMLElement | ParentNode,
  selector: string,
  text: string
): HTMLElement | null => {
  const elements = (context as Element).querySelectorAll<HTMLElement>(selector);
  const target = text.trim().toLowerCase();
  return Array.from(elements).find((el) => el.textContent?.trim().toLowerCase() === target) || null;
};

export const waitForElement = async (
  factory: () => HTMLElement | null,
  timeoutMs: number = 8000,
  intervalMs: number = 150
): Promise<HTMLElement | null> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = factory();
    if (el) return el;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
};