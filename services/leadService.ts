// Lead-related service operations

import { getStorage, setStorage } from './chrome/storage';
import { STORAGE_KEYS } from '../constants/storage';
import type { Lead } from '../types';

export const saveLeadsCache = async (leads: Lead[]): Promise<void> => {
  await setStorage({ [STORAGE_KEYS.LEADS_CACHE]: leads });
};

export const getLeadsCache = async (): Promise<Lead[]> => {
  const result = await getStorage<Lead[]>(STORAGE_KEYS.LEADS_CACHE);
  return Array.isArray(result[STORAGE_KEYS.LEADS_CACHE]) ? result[STORAGE_KEYS.LEADS_CACHE] : [];
};

export const saveFilteredLeadsCache = async (leads: Lead[]): Promise<void> => {
  await setStorage({ [STORAGE_KEYS.FILTERED_LEADS_CACHE]: leads });
};

export const getFilteredLeadsCache = async (): Promise<Lead[]> => {
  const result = await getStorage<Lead[]>(STORAGE_KEYS.FILTERED_LEADS_CACHE);
  return Array.isArray(result[STORAGE_KEYS.FILTERED_LEADS_CACHE]) ? result[STORAGE_KEYS.FILTERED_LEADS_CACHE] : [];
};

export const saveContactedLeadsCache = async (leads: Lead[]): Promise<void> => {
  await setStorage({ [STORAGE_KEYS.CONTACTED_LEADS_CACHE]: leads });
};

export const getContactedLeadsCache = async (): Promise<Lead[]> => {
  const result = await getStorage<Lead[]>(STORAGE_KEYS.CONTACTED_LEADS_CACHE);
  return Array.isArray(result[STORAGE_KEYS.CONTACTED_LEADS_CACHE]) ? result[STORAGE_KEYS.CONTACTED_LEADS_CACHE] : [];
};