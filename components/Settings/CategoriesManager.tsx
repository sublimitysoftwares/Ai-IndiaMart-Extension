import React from 'react';

interface CategoriesManagerProps {
  categories: string[];
  newCategory: string;
  onNewCategoryChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (category: string) => void;
}

export const CategoriesManager: React.FC<CategoriesManagerProps> = ({
  categories,
  newCategory,
  onNewCategoryChange,
  onAdd,
  onRemove,
}) => {
  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-slate-300 mb-2">Categories</h3>
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          value={newCategory}
          onChange={(e) => onNewCategoryChange(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && onAdd()}
          placeholder="Add category"
          className="flex-1 bg-slate-800 border border-slate-700 text-slate-200 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          maxLength={100}
        />
        <button
          onClick={onAdd}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm"
        >
          Add
        </button>
      </div>
      <div className="max-h-32 overflow-y-auto bg-slate-800 rounded p-2 space-y-1">
        {categories.length === 0 ? (
          <p className="text-xs text-slate-500">No categories. Add one above.</p>
        ) : (
          categories.map((category, idx) => (
            <div key={idx} className="flex items-center justify-between bg-slate-700/50 rounded px-2 py-1 text-xs">
              <span className="text-slate-300">{category}</span>
              <button onClick={() => onRemove(category)} className="text-red-400 hover:text-red-300 ml-2">
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
};