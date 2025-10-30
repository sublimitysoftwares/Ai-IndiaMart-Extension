
import React from 'react';
import type { Lead } from '../types';

interface LeadCardProps {
  lead: Lead;
}

export const LeadCard: React.FC<LeadCardProps> = ({ lead }) => {
  
  return (
    <div className={`rounded-lg shadow-md overflow-hidden border transition-all duration-300 hover:shadow-indigo-500/20 ${
      lead.autoContacted ? 'bg-green-900/20 border-green-700' : 
      lead.passedFilter ? 'bg-blue-900/20 border-blue-700' : 
      'bg-slate-800 border-slate-700'
    }`}>
      <div className="p-4">
        <div className="flex justify-between items-start mb-2">
          <div className="flex-1">
            <h3 className="text-lg font-bold text-indigo-400">{lead.companyName || 'N/A'}</h3>
            {lead.enquiryTitle && (
              <p className="text-sm text-slate-400 mt-1">{lead.enquiryTitle}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {lead.autoContacted && (
              <span className="text-xs bg-green-600 text-white px-2 py-1 rounded">
                ✓ Contacted
              </span>
            )}
            {lead.passedFilter && !lead.autoContacted && (
              <span className="text-xs bg-blue-600 text-white px-2 py-1 rounded">
                ✓ Filtered
              </span>
            )}
          </div>
        </div>
        
        <p className="text-slate-300 text-sm mb-3">{lead.requirement}</p>
        
        <div className="grid grid-cols-2 gap-2 mb-3">
          {lead.quantity && (
            <div className="text-xs text-slate-400">
              <span className="text-slate-500">Qty:</span> {lead.quantity} units
            </div>
          )}
          {(lead.probableOrderValueMin || lead.probableOrderValueMax || lead.probableOrderValueRaw) && (
            <div className="text-xs text-slate-400">
              <span className="text-slate-500">Value:</span>{' '}
              {lead.probableOrderValueMin && lead.probableOrderValueMax && lead.probableOrderValueMin !== lead.probableOrderValueMax ? (
                <>{`₹${lead.probableOrderValueMin.toLocaleString()} – ₹${lead.probableOrderValueMax.toLocaleString()}`}</>
              ) : lead.probableOrderValueMin ? (
                <>₹{lead.probableOrderValueMin.toLocaleString()}</>
              ) : (
                <>{lead.probableOrderValueRaw}</>
              )}
            </div>
          )}
          {lead.category && (
            <div className="text-xs text-slate-400 col-span-2">
              <span className="text-slate-500">Category:</span> {lead.category}
            </div>
          )}
          {lead.fabric && (
            <div className="text-xs text-slate-400 col-span-2">
              <span className="text-slate-500">Fabric:</span> {lead.fabric}
            </div>
          )}
        </div>
        
        <div className="space-y-1 text-xs text-slate-400">
          <div>📍 {lead.location}</div>
          <div>📅 {lead.timestamp}</div>
          {lead.contactedAt && (
            <div className="mt-1 text-green-400">Contacted at: {new Date(lead.contactedAt).toLocaleTimeString()}</div>
          )}
        </div>
      </div>
    </div>
  );
};
