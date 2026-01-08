---
name: Refactor to Clean Architecture
overview: Refactor the codebase into a clean, modular architecture that separates concerns into constants, utilities, services, hooks, components, and feature modules. This will make it easy to add new features, modify existing ones, and maintain the codebase.
todos:
  - id: extract-constants
    content: Extract all constants from App.tsx, content.ts, and background.ts into constants/ directory (filters, selectors, messages, storage keys, timing)
    status: completed
  - id: create-utils
    content: Create utility modules in utils/ for DOM operations, time functions, text processing, and human behavior simulation
    status: completed
    dependencies:
      - extract-constants
  - id: create-services
    content: Create service layer in services/chrome/ for messaging, storage, and tabs, plus leadService.ts
    status: completed
    dependencies:
      - extract-constants
  - id: extract-hooks
    content: "Extract custom React hooks from App.tsx: useAgentState, useFilterConfig, useChromeMessages, useLeads"
    status: completed
    dependencies:
      - create-services
  - id: split-components
    content: "Split App.tsx UI into smaller components: AgentControls/, Settings/, LeadsList/, LoadingStates/"
    status: completed
    dependencies:
      - extract-hooks
  - id: refactor-content-features
    content: "Extract content.ts logic into feature modules: scraping/, filtering/, contact/, automation/"
    status: pending
    dependencies:
      - create-utils
      - create-services
  - id: refactor-background
    content: Split background.ts into messageHandlers.ts and stateManager.ts modules
    status: completed
    dependencies:
      - create-services
  - id: update-imports
    content: Update all imports across the codebase to use new module structure
    status: in_progress
    dependencies:
      - split-components
      - refactor-content-features
      - refactor-background
  - id: simplify-entry-points
    content: Simplify App.tsx, content.ts, and background.ts to be thin orchestrators
    status: in_progress
    dependencies:
      - update-imports
  - id: verify-functionality
    content: Test all functionality to ensure nothing is broken and build succeeds
    status: in_progress
    dependencies:
      - simplify-entry-points
---

# Refactor Codebase to Clean Architecture

## Overview

Refactor the monolithic files into a well-organized, maintainable structure that separates concerns and makes feature additions straightforward.

## Architecture Strategy

We'll use a **hybrid approach** combining:

- **Layer-based** organization for infrastructure (constants, utils, services)
- **Feature-based** modules for business logic (scraping, filtering, contact)
- **Component-based** UI with custom hooks for state management

## Folder Structure

```
src/
├── constants/           # All constants
│   ├── index.ts         # Main constants export
│   ├── filters.ts       # Filter-related constants
│   ├── selectors.ts     # DOM selectors
│   ├── messages.ts      # Message types
│   └── storage.ts       # Storage keys
├── types/               # TypeScript types (already exists)
│   └── index.ts         # Re-export all types
├── utils/               # Pure utility functions
│   ├── dom.ts           # DOM utilities
│   ├── time.ts          # Time/date utilities
│   ├── validation.ts    # Validation helpers
│   ├── text.ts          # Text sanitization/parsing
│   └── human.ts         # Human-like behavior simulation
├── services/            # Service layer for external APIs
│   ├── chrome/          # Chrome extension APIs
│   │   ├── messaging.ts # Message sending/receiving
│   │   ├── storage.ts   # Storage operations
│   │   └── tabs.ts      # Tab management
│   └── leadService.ts   # Lead-related operations
├── hooks/               # Custom React hooks
│   ├── useAgentState.ts # Agent state management
│   ├── useFilterConfig.ts # Filter configuration
│   ├── useChromeMessages.ts # Message handling
│   └── useLeads.ts      # Leads state management
├── components/          # React components (already exists)
│   ├── LeadCard.tsx     # (existing)
│   ├── AgentControls/   # New folder
│   │   ├── AgentControls.tsx
│   │   ├── AutoContactToggle.tsx
│   │   └── StatsDisplay.tsx
│   ├── Settings/        # New folder
│   │   ├── SettingsPanel.tsx
│   │   ├── KeywordsManager.tsx
│   │   ├── CategoriesManager.tsx
│   │   └── ThresholdInputs.tsx
│   ├── LeadsList/       # New folder
│   │   ├── LeadsList.tsx
│   │   └── FilterDetails.tsx
│   └── LoadingStates/   # New folder
│       └── LoadingSpinner.tsx
├── features/            # Feature modules for content script
│   ├── scraping/        # Lead scraping logic
│   │   ├── scraper.ts
│   │   └── parser.ts
│   ├── filtering/       # Lead filtering logic
│   │   ├── filterEngine.ts
│   │   └── filterCriteria.ts
│   ├── contact/         # Contact automation
│   │   ├── contactFlow.ts
│   │   ├── dialogHandler.ts
│   │   └── messageHandler.ts
│   └── automation/      # Automation orchestration
│       ├── scheduler.ts
│       └── stateManager.ts
├── content/             # Content script entry point
│   └── content.ts       # Main orchestrator
├── background/          # Background script
│   ├── background.ts    # Entry point
│   ├── messageHandlers.ts
│   └── stateManager.ts
└── App.tsx              # Simplified main component
```

## Implementation Plan

### Phase 1: Extract Constants

1. Create `constants/` directory
2. Extract all constants from `App.tsx`, `content.ts`, and `background.ts`:

   - Filter defaults (keywords, categories)
   - DOM selectors
   - Message types
   - Storage keys
   - Timing constants
   - Threshold values

### Phase 2: Create Utility Modules

1. Create `utils/` directory with pure functions:

   - `dom.ts`: `isElementVisible`, `sanitize`, `getInteractionContexts`
   - `time.ts`: `randomBetween`, `calculateNextMidnight`, time formatting
   - `text.ts`: Text matching, parsing utilities
   - `human.ts`: `simulateMouseMove`, `humanScrollBy`, delay functions

### Phase 3: Create Service Layer

1. Create `services/chrome/` directory:

   - `messaging.ts`: Wrapper for `chrome.runtime.sendMessage/onMessage`
   - `storage.ts`: Wrapper for `chrome.storage.local` operations
   - `tabs.ts`: Tab querying and navigation

2. Create `services/leadService.ts` for lead-related operations

### Phase 4: Refactor App.tsx

1. Extract custom hooks:

   - `useAgentState.ts`: Agent state, auto-contact, statistics
   - `useFilterConfig.ts`: Filter settings management
   - `useChromeMessages.ts`: Message listener setup
   - `useLeads.ts`: Leads state and sorting

2. Split UI into components:

   - `AgentControls/`: Toggle, stats, stop button
   - `Settings/`: Settings panel with sub-components
   - `LeadsList/`: Leads display and filter details
   - `LoadingStates/`: Loading spinner

3. Simplify `App.tsx` to orchestrate components

### Phase 5: Refactor content.ts

1. Extract feature modules:

   - `features/scraping/`: Lead card detection and parsing
   - `features/filtering/`: Filter evaluation logic
   - `features/contact/`: Contact flow, dialog handling
   - `features/automation/`: Scheduling and state management

2. Keep `content.ts` as a thin orchestrator that wires features together

### Phase 6: Refactor background.ts

1. Split into modules:

   - `messageHandlers.ts`: All message type handlers
   - `stateManager.ts`: Auto-contact state and suspension logic

2. Keep `background.ts` minimal, just initialization

### Phase 7: Type Definitions

1. Move all interfaces to `types/index.ts` or separate files
2. Ensure proper exports

## Key Benefits

1. **Easy Feature Addition**: Add new features by creating modules in `features/`
2. **Reusability**: Utilities and services can be imported anywhere
3. **Testability**: Each module can be tested independently
4. **Maintainability**: Clear separation of concerns
5. **Extensibility**: Easy to modify without breaking other parts

## Files to Create/Modify

**New Files (30+):**

- All files in `constants/`, `utils/`, `services/`, `hooks/`, `features/`, and component subfolders

**Major Refactors:**

- `App.tsx`: Reduce from 1450 lines to ~200 lines (orchestration only)
- `content.ts`: Reduce from 2921 lines to ~300 lines (orchestration only)
- `background.ts`: Split into multiple focused modules

**Preserve Functionality:**

- All existing functionality will be preserved
- No breaking changes to user-facing behavior
- All imports will be updated correctly

## Migration Strategy

1. Create new folder structure
2. Extract code incrementally (constants → utils → services → features)
3. Update imports as we go
4. Test after each phase
5. Final cleanup and verification

This refactoring will make the codebase maintainable and easy to extend with new features.