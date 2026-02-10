import { useState, useEffect } from 'react';
import type { FilterCriteria } from '../types';
import { getStorage, setStorage, addStorageChangeListener, removeStorageChangeListener } from '../services/chrome/storage';
import { sendMessageToTab, queryIndiaMARTTabs } from '../services/chrome/tabs';
import { DEFAULT_KEYWORDS, DEFAULT_CATEGORIES, DEFAULT_QUANTITY_THRESHOLD, DEFAULT_ORDER_VALUE_MIN } from '../constants/filters';
import { STORAGE_KEYS } from '../constants/storage';
import { MESSAGE_TYPES } from '../constants/messages';

export const useFilterConfig = (filterCriteria: FilterCriteria | null, showSettings: boolean) => {
  const [keywords, setKeywords] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [quantityMin, setQuantityMin] = useState<string>('100');
  const [quantityUnit, setQuantityUnit] = useState<string>('piece');
  const [orderValue, setOrderValue] = useState<string>('50000');
  const [settingsMessage, setSettingsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadFilterConfig = async () => {
    try {
      const result = await getStorage([
        STORAGE_KEYS.FILTER_KEYWORDS,
        STORAGE_KEYS.FILTER_CATEGORIES,
        STORAGE_KEYS.FILTER_QUANTITY,
        STORAGE_KEYS.FILTER_ORDER_VALUE
      ]);

      // Load keywords - allow empty arrays (user may have cleared the list intentionally)
      if (Array.isArray(result[STORAGE_KEYS.FILTER_KEYWORDS])) {
        // Storage has an array (even if empty) - use it
        setKeywords(result[STORAGE_KEYS.FILTER_KEYWORDS]);
      } else if (result[STORAGE_KEYS.FILTER_KEYWORDS] === undefined) {
        // Key doesn't exist in storage - use defaults for first-time initialization
        if (filterCriteria?.keywords && filterCriteria.keywords.length > 0) {
          setKeywords(filterCriteria.keywords);
        } else {
          setKeywords(DEFAULT_KEYWORDS);
          await setStorage({ [STORAGE_KEYS.FILTER_KEYWORDS]: DEFAULT_KEYWORDS });
        }
      }

      // Load categories - allow empty arrays (user may have cleared the list intentionally)
      if (Array.isArray(result[STORAGE_KEYS.FILTER_CATEGORIES])) {
        // Storage has an array (even if empty) - use it
        setCategories(result[STORAGE_KEYS.FILTER_CATEGORIES]);
      } else if (result[STORAGE_KEYS.FILTER_CATEGORIES] === undefined) {
        // Key doesn't exist in storage - use defaults for first-time initialization
        if (filterCriteria?.categories && filterCriteria.categories.length > 0) {
          setCategories(filterCriteria.categories);
        } else {
          setCategories(DEFAULT_CATEGORIES);
          await setStorage({ [STORAGE_KEYS.FILTER_CATEGORIES]: DEFAULT_CATEGORIES });
        }
      }

      // Load quantity threshold
      if (result[STORAGE_KEYS.FILTER_QUANTITY] && typeof result[STORAGE_KEYS.FILTER_QUANTITY] === 'object' && typeof result[STORAGE_KEYS.FILTER_QUANTITY].min === 'number') {
        const qty = result[STORAGE_KEYS.FILTER_QUANTITY];
        setQuantityMin(String(qty.min || DEFAULT_QUANTITY_THRESHOLD.min));
        setQuantityUnit(qty.unit || DEFAULT_QUANTITY_THRESHOLD.unit);
      } else if (filterCriteria?.quantity && typeof filterCriteria.quantity.min === 'number') {
        setQuantityMin(String(filterCriteria.quantity.min || DEFAULT_QUANTITY_THRESHOLD.min));
        setQuantityUnit(filterCriteria.quantity.unit || DEFAULT_QUANTITY_THRESHOLD.unit);
      } else {
        setQuantityMin(String(DEFAULT_QUANTITY_THRESHOLD.min));
        setQuantityUnit(DEFAULT_QUANTITY_THRESHOLD.unit);
      }

      // Load order value minimum
      if (typeof result[STORAGE_KEYS.FILTER_ORDER_VALUE] === 'number' && result[STORAGE_KEYS.FILTER_ORDER_VALUE] > 0) {
        setOrderValue(String(result[STORAGE_KEYS.FILTER_ORDER_VALUE]));
      } else if (typeof filterCriteria?.orderValueMin === 'number' && filterCriteria.orderValueMin > 0) {
        setOrderValue(String(filterCriteria.orderValueMin));
      } else {
        setOrderValue(String(DEFAULT_ORDER_VALUE_MIN));
      }
    } catch (error) {
      // On error, try to use filterCriteria as fallback
      if (filterCriteria) {
        if (filterCriteria.keywords) setKeywords(filterCriteria.keywords);
        if (filterCriteria.categories) setCategories(filterCriteria.categories);
        if (filterCriteria.quantity) {
          setQuantityMin(String(filterCriteria.quantity.min || DEFAULT_QUANTITY_THRESHOLD.min));
          setQuantityUnit(filterCriteria.quantity.unit || DEFAULT_QUANTITY_THRESHOLD.unit);
        }
        if (typeof filterCriteria.orderValueMin === 'number') {
          setOrderValue(String(filterCriteria.orderValueMin));
        }
      }
    }
  };

  const saveFilterConfig = async (
    newKeywords?: string[],
    newCategories?: string[],
    newQuantity?: { min: number; unit: string },
    newOrderValue?: number
  ): Promise<boolean> => {
    try {
      const toSave: Record<string, any> = {};

      if (newKeywords !== undefined) {
        const validated = newKeywords
          .filter(k => k.trim().length > 0 && k.trim().length <= 100)
          .map(k => k.trim())
          .slice(0, 500);
        toSave[STORAGE_KEYS.FILTER_KEYWORDS] = validated;
        setKeywords(validated);
      }

      if (newCategories !== undefined) {
        const validated = newCategories
          .filter(c => c.trim().length > 0 && c.trim().length <= 100)
          .map(c => c.trim())
          .slice(0, 500);
        toSave[STORAGE_KEYS.FILTER_CATEGORIES] = validated;
        setCategories(validated);
      }

      if (newQuantity !== undefined) {
        const validated = {
          min: Math.max(1, Math.min(newQuantity.min, 1000000)),
          unit: (newQuantity.unit || 'piece').trim().toLowerCase()
        };
        toSave[STORAGE_KEYS.FILTER_QUANTITY] = validated;
        setQuantityMin(String(validated.min));
        setQuantityUnit(validated.unit);
      }

      if (newOrderValue !== undefined) {
        const validated = Math.max(0, Math.min(newOrderValue, 100000000));
        toSave[STORAGE_KEYS.FILTER_ORDER_VALUE] = validated;
        setOrderValue(String(validated));
      }

      if (Object.keys(toSave).length > 0) {
        await setStorage(toSave);
        await new Promise(resolve => setTimeout(resolve, 100));

        const tabs = await queryIndiaMARTTabs();
        tabs.forEach(tab => {
          if (tab.id) {
            sendMessageToTab(tab.id, { type: MESSAGE_TYPES.FILTER_KEYWORDS_UPDATED });
          }
        });

        setSettingsMessage({ type: 'success', text: 'Filter settings saved successfully!' });
        setTimeout(() => setSettingsMessage(null), 3000);
        return true;
      }

      return false;
    } catch (error) {
      setSettingsMessage({ type: 'error', text: 'Failed to save filter settings.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      return false;
    }
  };

  const handleAddKeyword = () => {
    if (!newKeyword.trim() || newKeyword.trim().length > 100) {
      setSettingsMessage({ type: 'error', text: 'Keyword must be between 1-100 characters.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      return;
    }

    const trimmed = newKeyword.trim().toLowerCase();
    if (keywords.includes(trimmed)) {
      setSettingsMessage({ type: 'error', text: 'Keyword already exists.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      return;
    }

    const updated = [...keywords, trimmed];
    saveFilterConfig(updated, undefined);
    setNewKeyword('');
  };

  const handleRemoveKeyword = (keyword: string) => {
    const updated = keywords.filter(k => k !== keyword);
    saveFilterConfig(updated, undefined);
  };

  const handleAddCategory = () => {
    if (!newCategory.trim() || newCategory.trim().length > 100) {
      setSettingsMessage({ type: 'error', text: 'Category must be between 1-100 characters.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      return;
    }

    const trimmed = newCategory.trim().toLowerCase();
    if (categories.includes(trimmed)) {
      setSettingsMessage({ type: 'error', text: 'Category already exists.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      return;
    }

    const updated = [...categories, trimmed];
    saveFilterConfig(undefined, updated);
    setNewCategory('');
  };

  const handleRemoveCategory = (category: string) => {
    const updated = categories.filter(c => c !== category);
    saveFilterConfig(undefined, updated);
  };

  const handleUpdateQuantity = async () => {
    const numValue = parseInt(quantityMin.trim(), 10);
    if (isNaN(numValue) || numValue < 1 || numValue > 1000000) {
      setSettingsMessage({ type: 'error', text: 'Quantity must be between 1 and 1,000,000.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      setQuantityMin('100');
      return;
    }
    const unitTrimmed = quantityUnit.trim().toLowerCase() || 'piece';
    try {
      const success = await saveFilterConfig(undefined, undefined, { min: numValue, unit: unitTrimmed }, undefined);
      if (!success) {
        setSettingsMessage({ type: 'error', text: 'Failed to save quantity threshold.' });
        setTimeout(() => setSettingsMessage(null), 3000);
      }
    } catch (error) {
      setSettingsMessage({ type: 'error', text: 'Error saving quantity threshold.' });
      setTimeout(() => setSettingsMessage(null), 3000);
    }
  };

  const handleUpdateOrderValue = async () => {
    const numValue = parseInt(orderValue.trim(), 10);
    if (isNaN(numValue) || numValue < 0 || numValue > 100000000) {
      setSettingsMessage({ type: 'error', text: 'Order value must be between ₹0 and ₹100,000,000.' });
      setTimeout(() => setSettingsMessage(null), 3000);
      setOrderValue('50000');
      return;
    }
    try {
      const success = await saveFilterConfig(undefined, undefined, undefined, numValue);
      if (!success) {
        setSettingsMessage({ type: 'error', text: 'Failed to save order value threshold.' });
        setTimeout(() => setSettingsMessage(null), 3000);
      }
    } catch (error) {
      setSettingsMessage({ type: 'error', text: 'Error saving order value threshold.' });
      setTimeout(() => setSettingsMessage(null), 3000);
    }
  };

  const handleExportConfig = () => {
    const config = {
      keywords: keywords,
      categories: categories,
      quantity: { min: parseInt(quantityMin) || 100, unit: quantityUnit },
      orderValue: parseInt(orderValue) || 50000,
      version: '1.0',
      updated: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `indiamart-filter-config-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setSettingsMessage({ type: 'success', text: 'Configuration exported successfully!' });
    setTimeout(() => setSettingsMessage(null), 3000);
  };

  const handleImportConfig = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const config = JSON.parse(text);

      if (typeof config !== 'object' || config === null) {
        throw new Error('Invalid file format');
      }

      const importedKeywords: string[] = Array.isArray(config.keywords)
        ? config.keywords.filter((k: any) => typeof k === 'string' && k.trim().length > 0 && k.trim().length <= 100).slice(0, 500)
        : [];

      const importedCategories: string[] = Array.isArray(config.categories)
        ? config.categories.filter((c: any) => typeof c === 'string' && c.trim().length > 0 && c.trim().length <= 100).slice(0, 500)
        : [];

      const importedQuantity: { min: number; unit: string } | undefined =
        config.quantity && typeof config.quantity === 'object' && typeof config.quantity.min === 'number' && typeof config.quantity.unit === 'string'
          ? {
            min: Math.max(1, Math.min(config.quantity.min, 1000000)),
            unit: config.quantity.unit.trim().toLowerCase() || 'piece'
          }
          : undefined;

      const importedOrderValue: number | undefined =
        typeof config.orderValue === 'number' && config.orderValue >= 0 && config.orderValue <= 100000000
          ? Math.max(0, Math.min(config.orderValue, 100000000))
          : undefined;

      if (importedKeywords.length === 0 && importedCategories.length === 0 && importedQuantity === undefined && importedOrderValue === undefined) {
        setSettingsMessage({ type: 'error', text: 'No valid keywords, categories, quantity, or order value found in file.' });
        setTimeout(() => setSettingsMessage(null), 3000);
        return;
      }

      await saveFilterConfig(
        importedKeywords.length > 0 ? importedKeywords : keywords,
        importedCategories.length > 0 ? importedCategories : categories,
        importedQuantity,
        importedOrderValue
      );

      setSettingsMessage({ type: 'success', text: 'Configuration imported successfully!' });
      setTimeout(() => setSettingsMessage(null), 3000);
    } catch (error) {
      setSettingsMessage({ type: 'error', text: 'Failed to import configuration. Please check file format.' });
      setTimeout(() => setSettingsMessage(null), 3000);
    }

    event.target.value = '';
  };

  // Load config when settings panel opens or when filterCriteria updates
  useEffect(() => {
    if (showSettings) {
      loadFilterConfig();
      const retryTimer = setTimeout(() => {
        loadFilterConfig();
      }, 500);
      return () => clearTimeout(retryTimer);
    }
  }, [showSettings]);

  useEffect(() => {
    if (showSettings && filterCriteria) {
      loadFilterConfig();
    }
  }, [filterCriteria]);

  // Listen for storage changes
  useEffect(() => {
    const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'local') {
        const filterKeys = [
          STORAGE_KEYS.FILTER_KEYWORDS,
          STORAGE_KEYS.FILTER_CATEGORIES,
          STORAGE_KEYS.FILTER_QUANTITY,
          STORAGE_KEYS.FILTER_ORDER_VALUE
        ];
        const hasFilterChange = filterKeys.some(key => changes[key]);
        if (hasFilterChange && showSettings) {
          loadFilterConfig();
        }
      }
    };

    addStorageChangeListener(storageListener);
    return () => {
      removeStorageChangeListener(storageListener);
    };
  }, [showSettings]);

  return {
    keywords,
    categories,
    newKeyword,
    setNewKeyword,
    newCategory,
    setNewCategory,
    quantityMin,
    setQuantityMin,
    quantityUnit,
    setQuantityUnit,
    orderValue,
    setOrderValue,
    settingsMessage,
    handleAddKeyword,
    handleRemoveKeyword,
    handleAddCategory,
    handleRemoveCategory,
    handleUpdateQuantity,
    handleUpdateOrderValue,
    handleExportConfig,
    handleImportConfig,
    loadFilterConfig,
  };
};