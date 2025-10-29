export interface Lead {
  leadId: string;
  companyName: string;
  enquiryTitle: string;
  requirement: string;
  contactInfo: string;
  location: string;
  timestamp: string;
  quantityRaw?: string;
  quantity?: number;
  category?: string;
  fabric?: string;
  probableOrderValueRaw?: string;
  probableOrderValueMin?: number;
  probableOrderValueMax?: number;
  cardIndex?: number;
  passedFilter?: boolean;
  filterReason?: string;
  nextContactDelayMinutes?: number;
  autoContacted?: boolean;
  contactedAt?: string;
  potentialScore?: number;
  analysis?: string;
}

export interface QualifiedLead extends Lead {
  tabId: number;
  nextContactTime: number;
}
