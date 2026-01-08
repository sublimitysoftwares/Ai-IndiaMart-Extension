// DOM selectors used for scraping and interaction

export const LEAD_CARD_SELECTORS = [
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

export const CONTACT_BUTTON_TEXT = 'Contact Buyer Now';

export const SEND_REPLY_TEXT = 'Send Reply';
export const SEND_REPLY_SELECTOR = '.btn-latest';

export const SEND_REPLY_BUTTON_SELECTORS = [
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

export const CONTACT_BUTTON_SELECTORS = [
  'button',
  'a',
  '.btnCBN',
  '.btnCBN1',
  '[data-action="contact"]',
  '[onclick*="contactbuyernow"]',
  '[onclick*="contact"]',
  'button[type="button"]',
  'a[class*="btn"]',
  'button[class*="btn"]',
  '[role="button"]'
];

export const SUCCESS_SELECTORS = [
  '.toast-success',
  '.alert-success',
  '.success',
  '.thankyou-msg',
  '.submitted',
  '.msg-sent',
  '.message-sent',
  '[data-testid="reply-success"]',
];

export const ERROR_SELECTORS = [
  '.error',
  '.error-message',
  '.validation-error',
  '.field-error',
  '[role="alert"]',
  '.toast-error',
  '.alert-danger',
];

export const MODAL_SELECTORS = [
  '.modal',
  '.alert',
  '.popup',
  '.dialog',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '.modal-content',
  '.alert-box',
  '.error-modal',
  '.warning-modal'
];

export const SHOW_MORE_BUTTON_SELECTOR = 'button.show_more';

export const ZERO_BALANCE_REGEXES = [
  /buylead\s+balance\s*:?\s*0/i,
  /buy\s*lead\s*balance\s*:?\s*0/i,
  /buy\s*leads\s*balance\s*:?\s*0/i,
];