// App-specific types

export enum AppState {
  Idle,
  Loading,
  LeadsScraped,
  Error,
  AutoContact,
}

export interface AutoContactStats {
  totalContacted: number;
  totalFiltered: number;
  sessionStartTime: number;
}

export interface FilterCriteria {
  keywords?: string[];
  foreignIndicators?: string[];
  quantity?: { min?: number; unit?: string };
  orderValueMin?: number;
  categories?: string[];
}

export interface DailyContactStatsSummary {
  date: string;
  count: number;
  limit: number;
  dayOfWeek: number;
}

export interface CycleSummary {
  timestamp: string;
  totalLeads: number;
  qualifiedLeads: number;
  selectedLeads: Array<{ id?: string; company?: string; orderValue?: string }>;
  skippedLeads?: number;
  buyLeadBalance?: number;
  actions?: string[];
  errors?: string[];
  dailyStats?: DailyContactStatsSummary;
  backoffActive?: boolean;
}

export interface SuspensionState {
  active: boolean;
  resumeAt?: number;
  restoreAutoContact?: boolean;
}

export interface DailyContactStats {
  date: string;
  count: number;
  limit: number;
  dayOfWeek: number;
}