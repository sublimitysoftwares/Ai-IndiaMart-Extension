import { useState, useRef, useEffect } from 'react';
import type { AutoContactStats, DailyContactStatsSummary, CycleSummary } from '../types';
import { AppState } from '../types';
import { sendMessage } from '../services/chrome/messaging';
import { MESSAGE_TYPES } from '../constants';

export const useAgentState = () => {
  const [appState, setAppState] = useState<AppState>(AppState.Idle);
  const [autoContactEnabled, setAutoContactEnabled] = useState(false);
  const [agentStopped, setAgentStopped] = useState(false);
  const [agentInitialized, setAgentInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoContactStats, setAutoContactStats] = useState<AutoContactStats>({
    totalContacted: 0,
    totalFiltered: 0,
    sessionStartTime: Date.now()
  });
  const [dailyStats, setDailyStats] = useState<DailyContactStatsSummary | null>(null);
  const [cycleSummary, setCycleSummary] = useState<CycleSummary | null>(null);
  const [backoffNotice, setBackoffNotice] = useState<string | null>(null);
  const agentStoppedRef = useRef(false);
  const backoffTimerRef = useRef<number | null>(null);

  useEffect(() => {
    agentStoppedRef.current = agentStopped;
  }, [agentStopped]);

  const handleStartAgent = () => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      setError("Cannot communicate with the extension background script. Are you running this as an extension?");
      setAppState(AppState.Error);
      return;
    }

    setError(null);
    if (!agentInitialized) {
      setAppState(AppState.Loading);
    }
    setAgentStopped(false);
    agentStoppedRef.current = false;
    setAutoContactEnabled(true);
    setAppState(AppState.Loading);

    sendMessage({ type: MESSAGE_TYPES.START_AGENT }, (response: any) => {
      if (chrome.runtime.lastError) {
        setError('Failed to start agent. Please try again.');
        setAppState(AppState.Error);
        setAgentStopped(true);
        agentStoppedRef.current = true;
        setAutoContactEnabled(false);
        return;
      }

      if (response && response.success) {
        sendMessage({ type: MESSAGE_TYPES.ENABLE_AUTO_CONTACT });

        if (response.leadsPayload) {
          setAgentInitialized(true);
          setAppState(AppState.AutoContact);
        } else {
          setAppState(AppState.Loading);
          const queryStatus = (attempt: number = 1) => {
            sendMessage({ type: MESSAGE_TYPES.GET_AGENT_STATUS }, (statusResponse: any) => {
              if (statusResponse && statusResponse.success) {
                if (statusResponse.agentActive && statusResponse.leadsPayload) {
                  setAutoContactEnabled(Boolean(statusResponse.autoContactEnabled));
                  setAgentInitialized(true);
                  setAppState(statusResponse.autoContactEnabled ? AppState.AutoContact : AppState.LeadsScraped);
                  if (statusResponse.statistics) {
                    setAutoContactStats(prev => ({
                      ...prev,
                      totalFiltered: statusResponse.statistics.totalFiltered || prev.totalFiltered,
                      totalContacted: statusResponse.statistics.totalContacted || prev.totalContacted,
                    }));
                  }
                } else if (attempt < 3) {
                  setTimeout(() => queryStatus(attempt + 1), attempt === 1 ? 500 : 1000);
                } else {
                  setAppState(AppState.Loading);
                }
              }
            });
          };
          queryStatus(1);
        }
      }
    });
  };

  const handleToggleAutoContact = () => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;

    const newState = !autoContactEnabled;
    setAutoContactEnabled(newState);
    setAgentStopped(false);
    agentStoppedRef.current = false;

    if (newState) {
      setAppState(AppState.AutoContact);
      sendMessage({ type: MESSAGE_TYPES.ENABLE_AUTO_CONTACT }, (response: any) => {
        if (chrome.runtime.lastError) {
          setAutoContactEnabled(false);
          setAppState(AppState.LeadsScraped);
        } else if (response?.success) {
          setAutoContactStats({
            totalContacted: 0,
            totalFiltered: 0,
            sessionStartTime: Date.now()
          });
        }
      });
    } else {
      setAppState(AppState.LeadsScraped);
      sendMessage({ type: MESSAGE_TYPES.DISABLE_AUTO_CONTACT }, (response: any) => {
        if (chrome.runtime.lastError) {
          setAutoContactEnabled(true);
          setAppState(AppState.AutoContact);
        } else {
          sendMessage({ type: MESSAGE_TYPES.GET_AGENT_STATUS }, (statusResponse: any) => {
            if (statusResponse?.success && statusResponse.autoContactEnabled !== false) {
              setAutoContactEnabled(statusResponse.autoContactEnabled);
              setAppState(statusResponse.autoContactEnabled ? AppState.AutoContact : AppState.LeadsScraped);
            }
          });
        }
      });
    }
  };

  const handleStopAgent = () => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;

    setAgentStopped(true);
    agentStoppedRef.current = true;
    setAutoContactEnabled(false);
    setAppState(AppState.Idle);

    sendMessage({ type: MESSAGE_TYPES.DISABLE_AUTO_CONTACT }, () => {
      sendMessage({ type: MESSAGE_TYPES.STOP_AGENT });
    });
  };

  return {
    appState,
    setAppState,
    autoContactEnabled,
    setAutoContactEnabled,
    agentStopped,
    setAgentStopped,
    agentInitialized,
    setAgentInitialized,
    error,
    setError,
    autoContactStats,
    setAutoContactStats,
    dailyStats,
    setDailyStats,
    cycleSummary,
    setCycleSummary,
    backoffNotice,
    setBackoffNotice,
    agentStoppedRef,
    backoffTimerRef,
    handleStartAgent,
    handleToggleAutoContact,
    handleStopAgent,
  };
};