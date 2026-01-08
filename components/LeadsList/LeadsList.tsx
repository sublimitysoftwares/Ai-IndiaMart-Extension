import React from 'react';
import { LeadCard } from '../LeadCard';
import type { Lead } from '../../types';

interface LeadsListProps {
  leads: Lead[];
  filteredLeads: Lead[];
  autoContactEnabled: boolean;
}

export const LeadsList: React.FC<LeadsListProps> = ({ leads, filteredLeads, autoContactEnabled }) => {
  const displayLeads = autoContactEnabled ? filteredLeads : leads;

  return (
    <div className="p-4 space-y-4">
      {displayLeads.map((lead, index) => (
        <LeadCard key={index} lead={lead} />
      ))}
    </div>
  );
};