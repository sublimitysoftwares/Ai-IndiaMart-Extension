import React from 'react';
import type { FilterCriteria, CycleSummary } from '../../types';

interface FilterDetailsProps {
  filterCriteria: FilterCriteria | null;
  cycleSummary?: CycleSummary | null;
  showFilterDetails: boolean;
  onToggle: () => void;
}

export const FilterDetails: React.FC<FilterDetailsProps> = ({
  filterCriteria,
  cycleSummary,
  showFilterDetails,
  onToggle,
}) => {
  return (
    <>
      <button
        onClick={onToggle}
        className="w-full mt-2 text-xs text-slate-400 hover:text-slate-300 transition-colors"
      >
        {showFilterDetails ? '▼' : '▶'} View Filter Criteria
      </button>

      {showFilterDetails && (
        <div className="mt-2 p-2 bg-slate-900/50 rounded text-xs space-y-1 text-slate-400">
          {filterCriteria ? (
            <>
              {filterCriteria.keywords && filterCriteria.keywords.length > 0 && (
                <div>
                  ✓ Keywords: {filterCriteria.keywords.slice(0, 6).join(', ')}
                  {filterCriteria.keywords.length > 6 ? ', …' : ''}
                </div>
              )}
              {filterCriteria.foreignIndicators && filterCriteria.foreignIndicators.length > 0 && (
                <div>
                  ✓ Location: Rejects foreign leads (
                  {filterCriteria.foreignIndicators.map((item) => item.toUpperCase()).join(', ')})
                </div>
              )}
              {filterCriteria.quantity && typeof filterCriteria.quantity.min === 'number' && (
                <div>
                  ✓ Quantity: ≥ {filterCriteria.quantity.min}{' '}
                  {filterCriteria.quantity.unit ? `${filterCriteria.quantity.unit}s` : ''}
                </div>
              )}
              {typeof filterCriteria.orderValueMin === 'number' && (
                <div>✓ Order Value: ≥ ₹{filterCriteria.orderValueMin.toLocaleString()}</div>
              )}
              {filterCriteria.categories && filterCriteria.categories.length > 0 && (
                <div>✓ Categories: {filterCriteria.categories.join(', ')}</div>
              )}
              {!filterCriteria.keywords &&
                !filterCriteria.foreignIndicators &&
                !filterCriteria.quantity &&
                typeof filterCriteria.orderValueMin !== 'number' &&
                !filterCriteria.categories && <div className="italic text-slate-500">No active filters.</div>}
            </>
          ) : (
            <div className="italic text-slate-500">No filter information received yet.</div>
          )}

          {cycleSummary && (
            <div className="mt-3 p-3 bg-slate-900/40 border border-slate-800 rounded text-xs text-slate-300 space-y-1">
              <div className="text-slate-100 font-semibold">
                Last Cycle: {new Date(cycleSummary.timestamp).toLocaleTimeString()}
              </div>
              <div className="flex justify-between">
                <span>Scanned</span>
                <span>{cycleSummary.totalLeads}</span>
              </div>
              <div className="flex justify-between">
                <span>Qualified</span>
                <span>{cycleSummary.qualifiedLeads}</span>
              </div>
              <div className="flex justify-between">
                <span>Selected</span>
                <span>{cycleSummary.selectedLeads?.length || 0}</span>
              </div>
              {typeof cycleSummary.skippedLeads === 'number' && (
                <div className="flex justify-between">
                  <span>Skipped (human)</span>
                  <span>{cycleSummary.skippedLeads}</span>
                </div>
              )}
              {typeof cycleSummary.buyLeadBalance === 'number' && (
                <div className="flex justify-between">
                  <span>BuyLead Balance</span>
                  <span>{cycleSummary.buyLeadBalance}</span>
                </div>
              )}
              {cycleSummary.selectedLeads && cycleSummary.selectedLeads.length > 0 && (
                <div>
                  <div className="text-slate-400 mt-1">Selected Leads:</div>
                  <ul className="list-disc list-inside text-slate-400">
                    {cycleSummary.selectedLeads.map((lead, idx) => (
                      <li key={`selected-${lead.id || idx}`}>
                        {lead.company || lead.id} {lead.orderValue ? `(${lead.orderValue})` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {cycleSummary.actions && cycleSummary.actions.length > 0 && (
                <div>
                  <div className="text-slate-400 mt-1">Actions:</div>
                  <ul className="list-disc list-inside text-slate-400">
                    {cycleSummary.actions.map((action: string, idx: number) => (
                      <li key={`action-${idx}`}>{action}</li>
                    ))}
                  </ul>
                </div>
              )}
              {cycleSummary.errors && cycleSummary.errors.length > 0 && (
                <div>
                  <div className="text-red-400 mt-1">Errors:</div>
                  <ul className="list-disc list-inside text-red-400">
                    {cycleSummary.errors.map((error: string, idx: number) => (
                      <li key={`error-${idx}`}>{error}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
};