# IndiaMART Agent (Local Filtering)

Chrome extension that automates scraping and locally filtering IndiaMART leads, with an optional auto-contact workflow. The Gemini integration has been removed; everything runs on deterministic heuristics inside the extension.

---
## Features

### Lead scraping & filtering
- Extracts lead cards directly from the IndiaMART Seller Portal.
- Applies deterministic filters on enquiry title, location, category, quantity, and probable order value.
- Assigns a random next-contact delay (1, 5, or 10 minutes) to qualified leads for scheduling.

### Auto-contact (optional)
- When enabled from the popup, automatically opens each qualified lead, waits a randomized 4–6 minutes to mimic human pacing, and sends the prepared reply.
- Tracks contacted and filtered lead counts, session duration, and refresh status in the popup UI.
- Stops refreshing and contacting immediately when you toggle Auto Contact off or hit the **Stop Agent** button.

### Agent controls
- **Start Agent** — opens the Seller Portal, injects the content script, and begins scraping/filtering.
- **Auto Contact toggle** — automates contacting for qualified leads, with safety checks and stop support.
- **Stop Agent** — visible at all times; cancels auto-contact, clears queued work, and prevents further refreshes.

---

## Getting Started

### Prerequisites
- Node.js 18 or later
- npm 9 or later
- Google Chrome (for loading the extension)

### Install & build

1. Install dependencies
   ```bash
   npm install
   ```
2. Build the extension
   ```bash
   npm run build
   ```
   The compiled assets are written to the `dist/` folder.

### Load into Chrome

1. Open `chrome://extensions/` in Google Chrome.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and choose the `dist/` directory.
4. The extension will appear in your toolbar. Pin it for easy access.

### Usage workflow

1. Click the extension icon to open the popup.
2. Press **Start Agent** — the extension opens the IndiaMART Seller Portal and begins scraping.
3. Leads are filtered locally. Qualified leads show up in the popup with their details and filter reasons.
4. (Optional) Toggle **Auto Contact** to let the agent handle follow-ups automatically. You can stop it anytime via **Stop Agent**.
5. When you’re done, simply close the popup or use **Stop Agent** to halt refreshing and messaging.

---

## Development Notes

- All configuration is local; there are no external API keys or Gemini dependencies.
- Tailwind warnings about content glob patterns are known and do not affect functionality.
- If you need to tweak selectors or heuristics, see `content.ts` for scraping logic and filters.

---

## Scripts

```bash
npm run build   # Type-check and build the extension with Vite
npm run dev     # Vite watch build (useful during development)
```

---

## License

MIT © 2025

