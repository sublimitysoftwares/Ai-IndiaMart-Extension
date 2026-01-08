import { useState, useMemo } from 'react';
import type { Lead } from '../types';

export const useLeads = () => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filteredLeads, setFilteredLeads] = useState<Lead[]>([]);
  const [sortBy, setSortBy] = useState<'time' | 'company'>('time');

  const sortedLeads = useMemo(() => {
    const arr = [...leads];
    if (arr.length === 0) return arr;
    switch (sortBy) {
      case 'time': {
        const toTime = (t?: string) => {
          if (!t) return 0;
          const d = new Date(t);
          return isNaN(d.getTime()) ? 0 : d.getTime();
        };
        return arr.sort((a, b) => toTime(b.timestamp) - toTime(a.timestamp));
      }
      case 'company':
        return arr.sort((a, b) => (a.companyName || '').localeCompare(b.companyName || ''));
      default:
        return arr;
    }
  }, [leads, sortBy]);

  return {
    leads,
    setLeads,
    filteredLeads,
    setFilteredLeads,
    sortBy,
    setSortBy,
    sortedLeads,
  };
};