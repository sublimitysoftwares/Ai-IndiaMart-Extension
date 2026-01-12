// Background script state management

import type { Lead, SuspensionState, DailyContactStats } from '../types';
import { getStorage, setStorage, removeStorage } from '../services/chrome/storage';
import { BUY_LEAD_SUSPENSION_KEY, AGENT_STATE } from '../constants/storage';
import { calculateNextMidnight } from '../utils/time';

export interface AutoContactState {
  enabled: boolean;
  stopped: boolean;
  processedLeads: Set<string>;
  lastContactTime: number;
  statistics: {
    totalContacted: number;
    totalFiltered: number;
    sessionStartTime: number;
  };
}

export let autoContactState: AutoContactState = {
  enabled: false,
  stopped: false,
  processedLeads: new Set<string>(),
  lastContactTime: 0, // Not persisted
  statistics: {
    totalContacted: 0,
    totalFiltered: 0,
    sessionStartTime: Date.now() // Not persisted, resets on restart
  }
};

// Simplified state for storage to avoid quota limits
interface StoredAgentState {
  enabled: boolean;
  stopped: boolean;
}

export const persistAutoContactState = async (): Promise<void> => {
  try {
    const stateToStore: StoredAgentState = {
      enabled: autoContactState.enabled,
      stopped: autoContactState.stopped,
    };
    await setStorage({ [AGENT_STATE]: stateToStore });
  } catch (error) {
    console.error('Failed to persist agent state:', error);
  }
};

export const initializeAutoContactState = async (): Promise<void> => {
  try {
    const result = await getStorage(AGENT_STATE);
    const stored = result[AGENT_STATE] as StoredAgentState | undefined;
    if (stored) {
      autoContactState.enabled = stored.enabled;
      autoContactState.stopped = stored.stopped;
      console.log('[StateManager] Restored agent state:', stored);
    }
  } catch (error) {
    console.error('Failed to initialize agent state:', error);
  }
};

let _agentActive = false;
let _latestLeadsPayload: { allLeads: Lead[]; filteredLeads: Lead[]; autoContactEnabled?: boolean } | null = null;
let _suspensionState: SuspensionState = { active: false };

export const getSuspensionState = () => _suspensionState;
export const setSuspensionState = (value: SuspensionState) => {
  _suspensionState = value;
};
let _dailyStatsCache: DailyContactStats | null = null;

export const getAgentActive = () => _agentActive;
export const setAgentActive = (value: boolean) => {
  _agentActive = value;
};

export const getLatestLeadsPayload = () => _latestLeadsPayload;
export const setLatestLeadsPayload = (value: { allLeads: Lead[]; filteredLeads: Lead[]; autoContactEnabled?: boolean } | null) => {
  _latestLeadsPayload = value;
};

export const getDailyStatsCache = () => _dailyStatsCache;
export const setDailyStatsCache = (value: DailyContactStats | null) => {
  _dailyStatsCache = value;
};

export const persistSuspensionState = async (): Promise<void> => {
  try {
    await setStorage({ [BUY_LEAD_SUSPENSION_KEY]: getSuspensionState() });
  } catch (error) {
    // Failed to persist suspension state
  }
};

export const clearSuspensionState = async (): Promise<void> => {
  setSuspensionState({ active: false });
  try {
    await removeStorage(BUY_LEAD_SUSPENSION_KEY);
  } catch (error) {
    // Failed to clear suspension state
  }
};

export const initializeSuspensionState = async (): Promise<number | null> => {
  try {
    const result = await getStorage(BUY_LEAD_SUSPENSION_KEY);
    const stored = result[BUY_LEAD_SUSPENSION_KEY] as SuspensionState | undefined;
    if (!stored || !stored.active) {
      return null;
    }

    setSuspensionState(stored);
    const resumeAt = stored.resumeAt || calculateNextMidnight();

    return resumeAt <= Date.now() ? null : resumeAt;
  } catch (error) {
    // Failed to initialize suspension state
    return null;
  }
};