# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension ("IndiaMART Agent") that scrapes buy-lead cards from `https://seller.indiamart.com/*`, filters them locally with deterministic heuristics (keywords, category, Indian state/location, quantity, probable order value), and can optionally auto-contact qualified leads with human-like pacing. The Gemini integration was removed; `@google/genai` in `package.json` and the Gemini hosts in the manifest CSP are leftovers.

## Commands

```bash
npm install
npm run build   # tsc type-check, then vite build -> dist/
npm run dev     # vite build --watch (no type-check)
```

There are no tests and no linter. To try a change, run `npm run build`, then in `chrome://extensions` (Developer mode) **Load unpacked** the `dist/` folder, or reload it if it is already loaded. Reload the IndiaMART tab too so the new content script is picked up.

Note: `tsconfig.json` `include` lists only a few entry files (`index.tsx`, `App.tsx`, `types.ts`, `components/LeadCard.tsx`, `content.ts`, `vite.config.ts`). Files reached through their imports are checked; `background/` is only bundled by Vite, so `tsc` does not type-check it.

## Build specifics

- `vite.config.ts` has three Rollup inputs: `popup` (`index.html` → `index.tsx` → `App.tsx`), `background` (`background/background.ts`), and `content` (`content.ts`). `background.js` and `content.js` get fixed names, and everything else goes to `dist/assets/` with hashes. Output is unminified.
- Content scripts cannot be ES modules, so the custom `inlineContentDeps` plugin takes the shared chunks that `content.js` imports, strips their `import`/`export` syntax with regexes, and wraps everything in an IIFE. So code imported by `content.ts` (from `constants/`, `utils/`) must survive regex-based export stripping: avoid `export default`, re-export-from patterns, and import forms the regexes don't handle.
- **`public/manifest.json` is the manifest that ships** (copied into `dist/` via `publicDir`). It declares the background as `"type": "module"` and registers `content.js` as a content script. The root `manifest.json` is a stale copy; edit the one in `public/`.

## Architecture

Three runtime contexts talk through `chrome.runtime` / `chrome.tabs` messages and share `chrome.storage.local`:

1. **Popup UI** (`App.tsx` + `components/`, `hooks/`): React 19 + Tailwind. `useAgentState`, `useFilterConfig`, and `useLeads` hold the popup state. The popup sends control messages (start/stop agent, toggle auto-contact, filter updates) and shows stats and leads that it reads from storage and from incoming messages.
2. **Background service worker** (`background/`): `background.ts` is the thin entry point. It restores state, keeps a 2-minute keepalive alarm that re-sends `ENABLE_AUTO_CONTACT` to IndiaMART tabs while auto-contact is on, and handles the resume alarm after a zero-BuyLead-balance suspension. `messageHandlers.ts` routes messages by `MESSAGE_TYPES` and can inject `content.js` via `chrome.scripting`. `stateManager.ts` keeps suspension, auto-contact, and daily-stats state in memory and persists it to storage.
3. **Content script** (`content.ts`, ~3.6k lines, all inside one IIFE guarded by `GLOBAL_FLAG` so it is not initialized twice). It holds nearly all the business logic:
   - Scraping: `getLeadCardElements` (searches the document and shadow roots), `extractLead`, `buildLeadId`; `ensureMinimumLeadCards` auto-scrolls and clicks "show more" until it reaches the minimum lead target.
   - Filtering: `loadFilterConfig` / `saveFilterConfig`, `applyIntelligentFilter`.
   - Contacting: `performContactFlow` finds the Contact Buyer button, fills the message, clicks Send Reply, and confirms success. It also dismisses the expired-lead, already-purchased, zero-balance, and post-send screens. Clicks go through `triggerRobustClick`, and a page-context click bridge is installed for cases where synthetic events are ignored.
   - Automation loop: `startScrapeLoop`, `processLeadsWithFiltering`, and periodic processing/refresh timers. Refresh intervals differ between working hours and off hours (`constants/timing.ts`). It also covers a daily contact limit, error backoff, and random skips and reading delays (`utils/human.ts`).
   - Logs passed/rejected leads to storage, de-duplicated by stable MD5-based keys (`buildStableLeadLogKeys`), and keeps a refresh-baseline set of lead IDs.

Shared layers: `constants/` (message types, storage keys, DOM selectors, filter defaults, timings), `utils/` (DOM, text/rupee/quantity parsing, time, human-behavior simulation), `services/chrome/` (thin wrappers over the Chrome APIs, used by the background and the popup). Types live in `types.ts`; `types/index.ts` re-exports it along with `types/App.ts`.

Conventions:
- Add new message types to `constants/messages.ts` and storage keys to `constants/storage.ts`, using the `indiamart_*` prefix. `content.ts` still compares some message types as string literals.
- IndiaMART DOM selectors and button text live in `constants/selectors.ts`. Most scraping or contact breakage comes from IndiaMART markup changes, so start there and in `extractLead` / `performContactFlow`.
- Logs are prefixed with `[Content]` or `[Background]`.

## In-progress refactor

`.cursor/plans/refactor_to_clean_architecture_*.plan.md` describes an ongoing move to a modular layout (branch `code_refactor`). Constants, utils, services, hooks, components, and the background split are done. Still pending: splitting `content.ts` into feature modules (`scraping/`, `filtering/`, `contact/`, `automation/`), and making the entry points thin orchestrators. Any extraction from `content.ts` must keep working with the `inlineContentDeps` build plugin described above.
