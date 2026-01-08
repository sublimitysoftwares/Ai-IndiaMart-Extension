import React from 'react';

interface ThresholdInputsProps {
  quantityMin: string;
  quantityUnit: string;
  orderValue: string;
  onQuantityMinChange: (value: string) => void;
  onQuantityUnitChange: (value: string) => void;
  onOrderValueChange: (value: string) => void;
  onUpdateQuantity: () => void;
  onUpdateOrderValue: () => void;
}

export const ThresholdInputs: React.FC<ThresholdInputsProps> = ({
  quantityMin,
  quantityUnit,
  orderValue,
  onQuantityMinChange,
  onQuantityUnitChange,
  onOrderValueChange,
  onUpdateQuantity,
  onUpdateOrderValue,
}) => {
  return (
    <>
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-slate-300 mb-2">Quantity Threshold</h3>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={quantityMin}
            onChange={(e) => {
              const value = e.target.value;
              if (value === '' || /^\d+$/.test(value)) {
                onQuantityMinChange(value);
              }
            }}
            onKeyPress={(e) => e.key === 'Enter' && onUpdateQuantity()}
            onBlur={onUpdateQuantity}
            placeholder="Minimum quantity"
            className="flex-1 bg-slate-800 border border-slate-700 text-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <input
            type="text"
            value={quantityUnit}
            onChange={(e) => onQuantityUnitChange(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && onUpdateQuantity()}
            placeholder="Unit (e.g., piece)"
            className="w-28 bg-slate-800 border border-slate-700 text-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            onClick={onUpdateQuantity}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm"
          >
            Update
          </button>
        </div>
        <p className="text-xs text-slate-500">Current: ≥ {parseInt(quantityMin) || 0} {quantityUnit}</p>
      </div>

      <div className="mb-6">
        <h3 className="text-sm font-semibold text-slate-300 mb-2">Order Value Threshold</h3>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={orderValue}
            onChange={(e) => {
              const value = e.target.value;
              if (value === '' || /^\d+$/.test(value)) {
                onOrderValueChange(value);
              }
            }}
            onKeyPress={(e) => e.key === 'Enter' && onUpdateOrderValue()}
            onBlur={onUpdateOrderValue}
            placeholder="Minimum order value (₹)"
            className="flex-1 bg-slate-800 border border-slate-700 text-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            onClick={onUpdateOrderValue}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm"
          >
            Update
          </button>
        </div>
        <p className="text-xs text-slate-500">Current: ≥ ₹{(parseInt(orderValue) || 0).toLocaleString()}</p>
      </div>
    </>
  );
};