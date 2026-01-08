import React from 'react';

interface KeywordsManagerProps {
  keywords: string[];
  newKeyword: string;
  onNewKeywordChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (keyword: string) => void;
}

export const KeywordsManager: React.FC<KeywordsManagerProps> = ({
  keywords,
  newKeyword,
  onNewKeywordChange,
  onAdd,
  onRemove,
}) => {
  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-slate-300 mb-2">Keywords</h3>
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          value={newKeyword}
          onChange={(e) => onNewKeywordChange(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && onAdd()}
          placeholder="Add keyword (e.g., DAV School Blazers)"
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
        {keywords.length === 0 ? (
          <p className="text-xs text-slate-500">No keywords. Add one above.</p>
        ) : (
          keywords.map((keyword, idx) => (
            <div key={idx} className="flex items-center justify-between bg-slate-700/50 rounded px-2 py-1 text-xs">
              <span className="text-slate-300">{keyword}</span>
              <button onClick={() => onRemove(keyword)} className="text-red-400 hover:text-red-300 ml-2">
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
};