import React from 'react';
import { KeywordsManager } from './KeywordsManager';
import { CategoriesManager } from './CategoriesManager';
import { ThresholdInputs } from './ThresholdInputs';

interface SettingsPanelProps {
  keywords: string[];
  categories: string[];
  newKeyword: string;
  newCategory: string;
  quantityMin: string;
  quantityUnit: string;
  orderValue: string;
  settingsMessage: { type: 'success' | 'error'; text: string } | null;
  onNewKeywordChange: (value: string) => void;
  onNewCategoryChange: (value: string) => void;
  onQuantityMinChange: (value: string) => void;
  onQuantityUnitChange: (value: string) => void;
  onOrderValueChange: (value: string) => void;
  onAddKeyword: () => void;
  onRemoveKeyword: (keyword: string) => void;
  onAddCategory: () => void;
  onRemoveCategory: (category: string) => void;
  onUpdateQuantity: () => void;
  onUpdateOrderValue: () => void;
  onExport: () => void;
  onImport: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onClose: () => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  keywords,
  categories,
  newKeyword,
  newCategory,
  quantityMin,
  quantityUnit,
  orderValue,
  settingsMessage,
  onNewKeywordChange,
  onNewCategoryChange,
  onQuantityMinChange,
  onQuantityUnitChange,
  onOrderValueChange,
  onAddKeyword,
  onRemoveKeyword,
  onAddCategory,
  onRemoveCategory,
  onUpdateQuantity,
  onUpdateOrderValue,
  onExport,
  onImport,
  onClose,
}) => {
  return (
    <div className="border-b border-slate-800 p-4 bg-slate-900 max-h-[500px] overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-200">Filter Settings</h2>
        <button
          onClick={onClose}
          className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-white rounded"
        >
          ✕
        </button>
      </div>

      {settingsMessage && (
        <div
          className={`mb-4 p-2 rounded text-xs ${
            settingsMessage.type === 'success' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'
          }`}
        >
          {settingsMessage.text}
        </div>
      )}

      <KeywordsManager
        keywords={keywords}
        newKeyword={newKeyword}
        onNewKeywordChange={onNewKeywordChange}
        onAdd={onAddKeyword}
        onRemove={onRemoveKeyword}
      />

      <CategoriesManager
        categories={categories}
        newCategory={newCategory}
        onNewCategoryChange={onNewCategoryChange}
        onAdd={onAddCategory}
        onRemove={onRemoveCategory}
      />

      <ThresholdInputs
        quantityMin={quantityMin}
        quantityUnit={quantityUnit}
        orderValue={orderValue}
        onQuantityMinChange={onQuantityMinChange}
        onQuantityUnitChange={onQuantityUnitChange}
        onOrderValueChange={onOrderValueChange}
        onUpdateQuantity={onUpdateQuantity}
        onUpdateOrderValue={onUpdateOrderValue}
      />

      <div className="flex gap-2">
        <label className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm text-center cursor-pointer">
          Import JSON
          <input type="file" accept=".json" onChange={onImport} className="hidden" />
        </label>
        <button
          onClick={onExport}
          className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm"
        >
          Export JSON
        </button>
      </div>
    </div>
  );
};