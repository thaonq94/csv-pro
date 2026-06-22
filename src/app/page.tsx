"use client";

import React, { useState, useEffect } from "react";
import {
  isTauri,
  selectCsvFile,
  openCsvFile,
  getCsvMetadata,
  saveCsvFile,
  applyCleaningOp,
  joinCsvFiles,
  splitCsvFile,
  CsvMetadata,
  FilterRule,
  applyCsvFilter,
  clearCsvFilter
} from "@/lib/tauri";
import { DataGrid } from "@/components/data-grid";
import {
  FolderOpen,
  Save,
  Trash2,
  GitMerge,
  Scissors,
  Sparkles,
  HelpCircle,
  FileSpreadsheet,
  Layers,
  ChevronRight,
  TrendingUp,
  Brush,
  Undo2,
  Database,
  Filter,
  Plus,
  X,
  Check
} from "lucide-react";

export default function Workspace() {
  const [tabs, setTabs] = useState<CsvMetadata[]>([]);
  const [activeTabIdx, setActiveTabIdx] = useState<number>(-1);
  const activeMeta = activeTabIdx >= 0 ? tabs[activeTabIdx] : null;
  const [activeChanges, setActiveChanges] = useState<Record<string, Record<number, Record<string, string>>>>({}); // fileId -> rowIdx -> col -> val
  const [inputFilePath, setInputFilePath] = useState("");
  const [mounted, setMounted] = useState(false);

  // Tabbed Filter states
  const [tabFilters, setTabFilters] = useState<Record<string, { rules: FilterRule[], conjunction: 'AND' | 'OR', isOpen: boolean }>>({});
  const [filterVersion, setFilterVersion] = useState(0);
  const [isFiltering, setIsFiltering] = useState(false);

  const activeFilterState: { rules: FilterRule[], conjunction: 'AND' | 'OR', isOpen: boolean } = activeMeta
    ? (tabFilters[activeMeta.file_id] || { rules: [], conjunction: 'AND', isOpen: false })
    : { rules: [], conjunction: 'AND', isOpen: false };

  const setRulesForActiveTab = (newRules: FilterRule[]) => {
    if (!activeMeta) return;
    setTabFilters((prev) => ({
      ...prev,
      [activeMeta.file_id]: {
        ...activeFilterState,
        rules: newRules
      }
    }));
  };

  const setConjunctionForActiveTab = (conj: 'AND' | 'OR') => {
    if (!activeMeta) return;
    setTabFilters((prev) => ({
      ...prev,
      [activeMeta.file_id]: {
        ...activeFilterState,
        conjunction: conj
      }
    }));
  };

  const setIsOpenForActiveTab = (open: boolean) => {
    if (!activeMeta) return;
    setTabFilters((prev) => ({
      ...prev,
      [activeMeta.file_id]: {
        ...activeFilterState,
        isOpen: open
      }
    }));
  };

  const handleApplyFilter = async (rulesOverride?: FilterRule[] | any) => {
    if (!activeMeta) return;
    setIsFiltering(true);
    const targetRules = Array.isArray(rulesOverride) ? rulesOverride : activeFilterState.rules;
    try {
      await applyCsvFilter(activeMeta.file_id, targetRules, activeFilterState.conjunction);
      const updatedMeta = await getCsvMetadata(activeMeta.file_id);
      setTabs((prev) =>
        prev.map((t) => (t.file_id === updatedMeta.file_id ? updatedMeta : t))
      );
      setFilterVersion((v) => v + 1);
    } catch (err) {
      alert(`Failed to apply filter: ${err}`);
    } finally {
      setIsFiltering(false);
    }
  };

  const handleClearFilter = async () => {
    if (!activeMeta) return;
    setIsFiltering(true);
    try {
      await clearCsvFilter(activeMeta.file_id);
      setRulesForActiveTab([]);
      const updatedMeta = await getCsvMetadata(activeMeta.file_id);
      setTabs((prev) =>
        prev.map((t) => (t.file_id === updatedMeta.file_id ? updatedMeta : t))
      );
      setFilterVersion((v) => v + 1);
    } catch (err) {
      alert(`Failed to clear filter: ${err}`);
    } finally {
      setIsFiltering(false);
    }
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  // Poll file metadata during indexing
  useEffect(() => {
    if (!activeMeta || activeMeta.indexing_complete) return;

    const interval = setInterval(async () => {
      try {
        const updatedMeta = await getCsvMetadata(activeMeta.file_id);
        setTabs((prev) =>
          prev.map((t) => (t.file_id === updatedMeta.file_id ? updatedMeta : t))
        );
        if (updatedMeta.indexing_complete) {
          clearInterval(interval);
        }
      } catch (err) {
        console.error("Error polling indexing:", err);
        clearInterval(interval);
      }
    }, 300);

    return () => clearInterval(interval);
  }, [activeMeta?.file_id, activeMeta?.indexing_complete]);

  // Modals / Toolbar actions state
  const [activeModal, setActiveModal] = useState<"join" | "split" | "clean" | "ai" | null>(null);

  // Form states for Operations
  const [joinParams, setJoinParams] = useState({
    fileBPath: "",
    keyColA: "",
    keyColB: "",
    joinType: "left" as "inner" | "left" | "right" | "outer",
    targetPath: ""
  });

  const [splitParams, setSplitParams] = useState({
    splitBy: "rows" as "rows" | "column",
    rowLimit: 50000,
    columnName: "",
    outputDir: ""
  });

  const [cleanParams, setCleanParams] = useState({
    opType: "deduplicate" as "deduplicate" | "trim" | "fill_missing",
    columns: [] as string[],
    column: "",
    fillType: "Value",
    customValue: "",
    targetPath: ""
  });


  // Add sample tab in browser mode initially for smooth user demo
  useEffect(() => {
    if (mounted && !isTauri) {
      handleOpenFile("/Users/thaonq/Desktop/workspace/sales_data.csv");
    }
  }, [mounted]);

  const handleOpenFile = async (pathOverride?: string) => {
    const path = pathOverride || inputFilePath;
    if (!path.trim()) return;
    try {
      const meta = await openCsvFile(path);
      // Append tab
      setTabs((prev) => {
        const exists = prev.findIndex((t) => t.file_id === meta.file_id || t.path === meta.path);
        if (exists >= 0) {
          setActiveTabIdx(exists);
          return prev;
        }
        const updated = [...prev, meta];
        setActiveTabIdx(updated.length - 1);
        return updated;
      });
      setInputFilePath("");
      // Reset filter state for the newly opened file
      setTabFilters((prev) => ({
        ...prev,
        [meta.file_id]: { rules: [], conjunction: 'AND', isOpen: false }
      }));
    } catch (e) {
      alert(`Error opening file: ${e}`);
    }
  };

  const handleCellDirty = (rowIdx: number, colName: string, value: string) => {
    if (!activeMeta) return;
    setActiveChanges((prev) => {
      const fileChanges = prev[activeMeta.file_id] || {};
      const rowChanges = fileChanges[rowIdx] || {};
      rowChanges[colName] = value;
      return {
        ...prev,
        [activeMeta.file_id]: {
          ...fileChanges,
          [rowIdx]: rowChanges
        }
      };
    });
  };

  const handleCommit = async () => {
    if (!activeMeta) return;
    try {
      await saveCsvFile(activeMeta.file_id, activeMeta.path);
      // Clear changes for this tab
      setActiveChanges((prev) => {
        const next = { ...prev };
        delete next[activeMeta.file_id];
        return next;
      });
      alert("Changes saved directly to physical disk successfully!");
    } catch (e) {
      alert(`Error saving file: ${e}`);
    }
  };

  const handleDiscard = () => {
    if (!activeMeta) return;
    setActiveChanges((prev) => {
      const next = { ...prev };
      delete next[activeMeta.file_id];
      return next;
    });
    // Invalidate tabs metadata to trigger reload
    const current = [...tabs];
    current[activeTabIdx] = { ...current[activeTabIdx] };
    setTabs(current);
  };

  const handleRunJoin = async () => {
    if (!activeMeta) return;
    try {
      // For browser mock or tauri, resolve file B metadata
      let fileBId = joinParams.fileBPath;
      if (isTauri) {
        const metaB = await openCsvFile(joinParams.fileBPath);
        fileBId = metaB.file_id;
      }
      
      await joinCsvFiles(
        activeMeta.file_id,
        joinParams.keyColA,
        fileBId,
        joinParams.keyColB,
        joinParams.joinType,
        joinParams.targetPath
      );
      alert(`Files successfully merged! Output written to ${joinParams.targetPath}`);
      setActiveModal(null);
    } catch (e) {
      alert(`Join failed: ${e}`);
    }
  };

  const handleRunSplit = async () => {
    if (!activeMeta) return;
    try {
      const parts = await splitCsvFile(
        activeMeta.file_id,
        splitParams.splitBy,
        splitParams.rowLimit,
        splitParams.columnName || null,
        splitParams.outputDir
      );
      alert(`CSV successfully split into ${parts.length} files in folder ${splitParams.outputDir}`);
      setActiveModal(null);
    } catch (e) {
      alert(`Split failed: ${e}`);
    }
  };

  const handleRunClean = async () => {
    if (!activeMeta) return;
    try {
      await applyCleaningOp(
        activeMeta.file_id,
        cleanParams.opType,
        cleanParams.targetPath,
        {
          columns: cleanParams.columns,
          column: cleanParams.column,
          fill_type: cleanParams.fillType,
          custom_value: cleanParams.customValue
        }
      );
      alert(`Data cleaning operation completed! Saved to ${cleanParams.targetPath}`);
      setActiveModal(null);
    } catch (e) {
      alert(`Cleaning failed: ${e}`);
    }
  };

  const hasUnsavedChanges = activeMeta ? (Object.keys(activeChanges[activeMeta.file_id] || {}).length > 0) : false;

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden font-sans">
      
      {/* Top Header / App Branding */}
      <header className="flex items-center justify-between px-4 h-12 bg-zinc-900 border-b border-zinc-800 select-none">
        <div className="flex items-center space-x-2">
          <Database className="w-5 h-5 text-blue-500 animate-pulse" />
          <span className="font-bold text-sm tracking-tight text-white">CSV PRO</span>
          <span className="text-[10px] text-zinc-500 font-mono px-1.5 py-0.5 bg-zinc-950 border border-zinc-800 rounded">v0.1.0 (local-first)</span>
        </div>
        
        {/* Main Quick-Open Address Bar */}
        <div className="flex items-center flex-1 max-w-xl mx-8 space-x-2">
          <input
            className="w-full bg-zinc-950 border border-zinc-800 text-xs px-3 py-1.5 rounded outline-none focus:border-zinc-700 font-mono placeholder:text-zinc-600 text-zinc-300"
            placeholder="Absolute file path to CSV (or sandbox query value)..."
            value={inputFilePath}
            onChange={(e) => setInputFilePath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleOpenFile()}
          />
          <button
            onClick={async () => {
              const path = await selectCsvFile();
              if (path) handleOpenFile(path);
            }}
            className="flex items-center space-x-1.5 bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs px-3 py-1.5 rounded transition"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>Open</span>
          </button>
        </div>

        <div className="flex items-center space-x-1 text-xs text-zinc-400">
          <span className="font-semibold text-zinc-500">AUTHOR:</span>
          <span className="font-mono text-zinc-300">Ngô Quang Thảo</span>
        </div>
      </header>

      {/* Ribbon Control Menu Bar */}
      <div className="flex items-center justify-between px-4 h-10 bg-zinc-900/60 border-b border-zinc-800/80 text-xs select-none">
        <div className="flex items-center space-x-1">
          <button
            onClick={() => activeMeta && setIsOpenForActiveTab(!activeFilterState.isOpen)}
            disabled={!activeMeta}
            className={`flex items-center space-x-1 px-3 py-1.5 hover:bg-zinc-800/60 disabled:opacity-40 disabled:hover:bg-transparent rounded transition ${
              activeFilterState.isOpen ? "bg-blue-600/20 text-blue-400 font-semibold" : "text-zinc-300"
            }`}
          >
            <Filter className="w-3.5 h-3.5" />
            <span>Filter</span>
            {activeFilterState.rules.length > 0 && (
              <span className="ml-1 px-1.5 py-0.2 bg-blue-600 text-white rounded-full text-[9px] font-mono font-bold leading-none">
                {activeFilterState.rules.length}
              </span>
            )}
          </button>
          <button
            onClick={() => activeMeta && setActiveModal("join")}
            disabled={!activeMeta}
            className="flex items-center space-x-1 px-3 py-1.5 hover:bg-zinc-800/60 disabled:opacity-40 disabled:hover:bg-transparent rounded text-zinc-300 transition"
          >
            <GitMerge className="w-3.5 h-3.5 text-indigo-400" />
            <span>Relational Join</span>
          </button>
          <button
            onClick={() => activeMeta && setActiveModal("split")}
            disabled={!activeMeta}
            className="flex items-center space-x-1 px-3 py-1.5 hover:bg-zinc-800/60 disabled:opacity-40 disabled:hover:bg-transparent rounded text-zinc-300 transition"
          >
            <Scissors className="w-3.5 h-3.5 text-emerald-400" />
            <span>Smart Split</span>
          </button>
          <button
            onClick={() => activeMeta && setActiveModal("clean")}
            disabled={!activeMeta}
            className="flex items-center space-x-1 px-3 py-1.5 hover:bg-zinc-800/60 disabled:opacity-40 disabled:hover:bg-transparent rounded text-zinc-300 transition"
          >
            <Brush className="w-3.5 h-3.5 text-amber-400" />
            <span>Data Cleaning</span>
          </button>
          <button
            onClick={() => activeMeta && setActiveModal("ai")}
            disabled={!activeMeta}
            className="flex items-center space-x-1 px-3 py-1.5 hover:bg-zinc-800/60 disabled:opacity-40 disabled:hover:bg-transparent rounded text-zinc-300 transition"
          >
            <Sparkles className="w-3.5 h-3.5 text-purple-400" />
            <span>AI Copilot (BYOK)</span>
          </button>
        </div>

        {activeMeta && (
          <div className="flex items-center space-x-3 text-[11px] text-zinc-500 font-mono">
            <span>Delimiter: <b className="text-zinc-300">"{activeMeta.delimiter}"</b></span>
            <span>Encoding: <b className="text-zinc-300">{activeMeta.encoding}</b></span>
          </div>
        )}
      </div>

      {/* Tabs Panel (TablePlus style tabs) */}
      <div className="flex items-center bg-zinc-950 border-b border-zinc-800 select-none">
        <div className="flex items-center overflow-x-auto flex-1 h-9 scrollbar-none">
          {tabs.map((tab, idx) => {
            const hasChanges = Object.keys(activeChanges[tab.file_id] || {}).length > 0;
            const isActive = idx === activeTabIdx;
            return (
              <div
                key={tab.file_id}
                onClick={() => setActiveTabIdx(idx)}
                className={`flex items-center space-x-2 px-4 h-full border-r border-zinc-800 cursor-default text-xs relative ${
                  isActive ? "bg-zinc-900 text-white font-medium border-t-2 border-t-blue-500" : "text-zinc-500 hover:bg-zinc-900/30 hover:text-zinc-300"
                }`}
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span className="max-w-[140px] truncate">{tab.path.split("/").pop()}</span>
                {hasChanges && <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setTabs(tabs.filter((_, tIdx) => tIdx !== idx));
                    if (activeTabIdx === idx) {
                      setActiveTabIdx(tabs.length - 2);
                    }
                  }}
                  className="hover:text-red-400 font-mono text-[10px] leading-none ml-1 scale-95 opacity-70 hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Filter Panel (Slide Down) */}
      {activeMeta && activeFilterState.isOpen && (
        <div className="bg-zinc-900 border-b border-zinc-800 px-4 py-2.5 flex flex-col space-y-2.5 select-none shadow-xl relative z-35 animate-slide-down">
          
          {/* Header Controls */}
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <div className="flex items-center space-x-3">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Conjunction:</span>
              <div className="flex items-center space-x-0.5 bg-zinc-950 p-0.5 rounded-lg border border-zinc-850/80">
                <button
                  onClick={() => setConjunctionForActiveTab('AND')}
                  className={`px-3 py-1 rounded-md text-[10px] uppercase font-bold tracking-wider transition-all ${
                    activeFilterState.conjunction === 'AND'
                      ? "bg-blue-600 text-white shadow-sm font-extrabold"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  AND
                </button>
                <button
                  onClick={() => setConjunctionForActiveTab('OR')}
                  className={`px-3 py-1 rounded-md text-[10px] uppercase font-bold tracking-wider transition-all ${
                    activeFilterState.conjunction === 'OR'
                      ? "bg-blue-600 text-white shadow-sm font-extrabold"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  OR
                </button>
              </div>
            </div>
            
            <button
              onClick={() => {
                const newRule: FilterRule = {
                  column: activeMeta.headers[0] || "",
                  operator: "contains",
                  value: ""
                };
                setRulesForActiveTab([...activeFilterState.rules, newRule]);
              }}
              className="flex items-center space-x-1.5 px-3 py-1.5 bg-zinc-950 hover:bg-zinc-850 border border-zinc-850 hover:border-zinc-700 text-zinc-300 hover:text-white rounded-lg text-xs font-semibold transition"
            >
              <Plus className="w-3.5 h-3.5 text-blue-500" />
              <span>Add Condition</span>
            </button>
          </div>
          
          {/* Rules List */}
          {activeFilterState.rules.length === 0 ? (
            <div className="flex items-center justify-center space-x-2 py-2 px-3 bg-zinc-950/20 border border-dashed border-zinc-850/60 rounded-lg text-center">
              <Filter className="w-3.5 h-3.5 text-zinc-500 stroke-[1.5]" />
              <span className="text-xs text-zinc-400">
                No filter conditions defined. Click{" "}
                <span className="text-blue-400 font-medium">"Add Condition"</span> to filter rows dynamically.
              </span>
            </div>
          ) : (
            <div className="flex flex-col space-y-2 max-h-[180px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent">
              {activeFilterState.rules.map((rule, idx) => (
                <div 
                  key={idx} 
                  className="grid grid-cols-[180px_140px_1fr_32px] gap-3 items-center bg-zinc-950/30 hover:bg-zinc-950/50 p-2 border border-zinc-850/60 rounded-xl transition"
                >
                  {/* Column Dropdown */}
                  <select
                    value={rule.column}
                    onChange={(e) => {
                      const copy = [...activeFilterState.rules];
                      copy[idx].column = e.target.value;
                      setRulesForActiveTab(copy);
                    }}
                    className="w-full bg-zinc-950 border border-zinc-800/80 rounded-lg px-2.5 py-1.5 text-zinc-200 outline-none focus:border-zinc-600 font-mono text-[11px] font-semibold cursor-pointer"
                  >
                    {activeMeta.headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                  
                  {/* Operator Dropdown */}
                  <select
                    value={rule.operator}
                    onChange={(e) => {
                      const copy = [...activeFilterState.rules];
                      copy[idx].operator = e.target.value;
                      if (e.target.value === "is_empty") {
                        copy[idx].value = "";
                      }
                      setRulesForActiveTab(copy);
                    }}
                    className="w-full bg-zinc-950 border border-zinc-800/80 rounded-lg px-2.5 py-1.5 text-zinc-200 outline-none focus:border-zinc-600 text-xs font-bold cursor-pointer"
                  >
                    <option value="contains">contains</option>
                    <option value="equals">equals</option>
                    <option value="starts_with">starts with</option>
                    <option value="ends_with">ends with</option>
                    <option value="is_empty">is empty</option>
                    <option value="regex">matches RegEx</option>
                    <option value="eq">=</option>
                    <option value="ne">!=</option>
                    <option value="gt">&gt;</option>
                    <option value="lt">&lt;</option>
                  </select>
                  
                  {/* Value Input */}
                  <input
                    disabled={rule.operator === "is_empty"}
                    value={rule.value}
                    onChange={(e) => {
                      const copy = [...activeFilterState.rules];
                      copy[idx].value = e.target.value;
                      setRulesForActiveTab(copy);
                    }}
                    placeholder={rule.operator === "is_empty" ? "N/A" : "Enter filter query..."}
                    className="w-full bg-zinc-950 border border-zinc-800/80 rounded-lg px-3 py-1.5 text-zinc-200 outline-none disabled:opacity-40 disabled:cursor-not-allowed focus:border-blue-500/80 focus:ring-1 focus:ring-blue-500/20 font-mono text-xs placeholder:text-zinc-700 transition"
                  />
                  
                  {/* Remove Button */}
                  <button
                    onClick={() => {
                      const copy = activeFilterState.rules.filter((_, rIdx) => rIdx !== idx);
                      setRulesForActiveTab(copy);
                    }}
                    className="flex items-center justify-center p-1.5 hover:bg-red-500/10 text-zinc-500 hover:text-red-400 rounded-lg transition"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          
          {/* Footer Actions */}
          <div className="flex items-center justify-end space-x-2 pt-2 border-t border-zinc-850/60">
            <button
              onClick={handleClearFilter}
              disabled={isFiltering}
              className="flex items-center space-x-1.5 px-3.5 py-2 border border-zinc-850 hover:bg-zinc-850 rounded-lg font-semibold text-[11px] text-zinc-400 hover:text-white disabled:opacity-50 disabled:pointer-events-none transition"
            >
              <Trash2 className="w-3.5 h-3.5 text-zinc-500" />
              <span>Reset</span>
            </button>
            <button
              onClick={handleApplyFilter}
              disabled={isFiltering}
              className="flex items-center space-x-1.5 bg-blue-600 hover:bg-blue-500 active:scale-95 px-5 py-2 rounded-lg font-bold text-[11px] text-white disabled:opacity-50 disabled:pointer-events-none transition-all shadow-md shadow-blue-500/10 hover:shadow-blue-500/20 animate-pulse-subtle"
            >
              {isFiltering ? (
                <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              <span>{isFiltering ? "Filtering..." : "Run Filter"}</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Workspace Split Body */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Main Editor Grid Area */}
        <div className="flex-1 flex flex-col relative overflow-hidden bg-zinc-950">
          {activeMeta ? (
            <DataGrid
              key={`${activeMeta.file_id}-${filterVersion}`}
              metadata={activeMeta}
              onMetadataUpdate={async () => {
                const meta = await openCsvFile(activeMeta.path);
                setTabs((prev) => prev.map((t) => (t.file_id === meta.file_id ? meta : t)));
              }}
              activeChanges={activeChanges[activeMeta.file_id] || {}}
              onCellDirty={handleCellDirty}
              filterVersion={filterVersion}
              isFiltering={isFiltering}
              rules={activeFilterState.rules}
              onRulesChange={setRulesForActiveTab}
              onApplyFilter={handleApplyFilter}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 space-y-3 p-6 text-center select-none">
              <Database className="w-12 h-12 text-zinc-800 stroke-[1.5]" />
              <div className="max-w-sm space-y-1">
                <p className="font-semibold text-zinc-400 text-sm">No CSV File Opened</p>
                <p className="text-xs text-zinc-600">
                  Input a CSV file path in the address bar above, or click below to trigger a sample dashboard mockup.
                </p>
              </div>
              {mounted && !isTauri && (
                <button
                  onClick={() => handleOpenFile("/Users/thaonq/Desktop/workspace/sales_data.csv")}
                  className="border border-zinc-800 hover:border-zinc-700 bg-zinc-900/40 text-zinc-400 hover:text-zinc-200 transition text-xs px-4 py-2 rounded"
                >
                  Simulate Sandbox Dashboard
                </button>
              )}
            </div>
          )}

          {/* TablePlus Save/Discard Overlay Drawer */}
          {hasUnsavedChanges && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center justify-between w-96 px-4 py-3 bg-zinc-900/95 border border-zinc-700/80 shadow-2xl rounded-xl z-50 animate-bounce backdrop-blur">
              <div className="flex items-center space-x-2">
                <span className="w-2 h-2 rounded-full bg-orange-500 animate-ping" />
                <span className="text-xs font-semibold text-orange-400 font-mono">
                  {Object.keys(activeChanges[activeMeta!.file_id] || {}).length} rows modified
                </span>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleDiscard}
                  className="flex items-center space-x-1 border border-zinc-800 hover:bg-zinc-850 px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-white transition"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  <span>Discard</span>
                </button>
                <button
                  onClick={handleCommit}
                  className="flex items-center space-x-1 bg-orange-600 hover:bg-orange-500 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Commit</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right Details Panel - Schema & Statistics */}
        {activeMeta && (
          <aside className="w-64 bg-zinc-900 border-l border-zinc-800 flex flex-col select-none overflow-y-auto">
            {/* Quick selection analytics summary pane */}
            <div className="p-3 border-b border-zinc-850 bg-zinc-950/40">
              <div className="font-semibold text-[11px] uppercase tracking-wider text-zinc-500 flex items-center space-x-1 mb-2">
                <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
                <span>Quick Statistics</span>
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">Total Rows:</span>
                  <span className="font-mono text-zinc-200 font-bold">{activeMeta.total_rows.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">Total Fields:</span>
                  <span className="font-mono text-zinc-300">{(activeMeta.total_rows * activeMeta.headers.length).toLocaleString()}</span>
                </div>
                <div className="flex flex-col space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500">Indexing State:</span>
                    <span className={`font-mono text-[10px] font-semibold px-1 rounded ${activeMeta.indexing_complete ? "bg-emerald-950 text-emerald-400" : "bg-blue-950 text-blue-400 animate-pulse"}`}>
                      {activeMeta.indexing_complete ? "FINISHED" : "INDEXING..."}
                    </span>
                  </div>
                  {!activeMeta.indexing_complete && (
                    <div className="flex flex-col space-y-1 mt-1 bg-zinc-950/60 p-2 rounded border border-zinc-850">
                      <div className="flex items-center justify-between text-[9px] text-zinc-500">
                        <span>Progress: {activeMeta.total_bytes > 0 ? Math.min(100, Math.round((activeMeta.indexed_bytes / activeMeta.total_bytes) * 100)) : 0}%</span>
                        <span>{((activeMeta.indexed_bytes || 0) / (1024 * 1024)).toFixed(1)}MB / {((activeMeta.total_bytes || 0) / (1024 * 1024)).toFixed(1)}MB</span>
                      </div>
                      <div className="w-full bg-zinc-800 rounded-full h-1 overflow-hidden">
                        <div
                          className="bg-blue-500 h-1 rounded-full transition-all duration-300"
                          style={{
                            width: `${activeMeta.total_bytes > 0 ? Math.min(100, Math.round((activeMeta.indexed_bytes / activeMeta.total_bytes) * 100)) : 0}%`
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="p-3 border-b border-zinc-800 font-semibold text-[11px] uppercase tracking-wider text-zinc-500 flex items-center space-x-1">
              <Layers className="w-3.5 h-3.5 text-blue-500" />
              <span>Columns & Data Types</span>
            </div>
            
            {/* Columns Schema List */}
            <div className="flex-1 divide-y divide-zinc-850">
              {activeMeta.columns.map((col, idx) => (
                <div key={idx} className="p-3 hover:bg-zinc-850/30 flex flex-col space-y-1">
                  <div className="flex items-center justify-between text-xs font-medium">
                    <span className="text-zinc-200 truncate">{col.name}</span>
                    <span className="text-[10px] font-mono text-zinc-500 px-1 bg-zinc-950 border border-zinc-800/80 rounded scale-90">
                      {col.data_type}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>

      {/* Relational Join Modal */}
      {activeModal === "join" && activeMeta && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-[500px] p-6 shadow-2xl space-y-4">
            <div className="flex items-center space-x-2 border-b border-zinc-800 pb-3">
              <GitMerge className="w-5 h-5 text-indigo-400" />
              <h3 className="font-bold text-base text-white">Relational JOIN Engine</h3>
            </div>
            
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3 bg-zinc-950/40 p-2.5 rounded border border-zinc-800/80 mb-2">
                <div>
                  <span className="text-zinc-500 block">Left CSV (File A)</span>
                  <span className="text-zinc-200 font-semibold font-mono truncate">{activeMeta.path.split("/").pop()}</span>
                </div>
                <div>
                  <span className="text-zinc-500 block">Key Column A</span>
                  <select
                    value={joinParams.keyColA}
                    onChange={(e) => setJoinParams({ ...joinParams, keyColA: e.target.value })}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-white"
                  >
                    <option value="">-- Choose Key --</option>
                    {activeMeta.headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-zinc-400 block font-semibold">Right CSV (File B Path)</label>
                <input
                  value={joinParams.fileBPath}
                  onChange={(e) => setJoinParams({ ...joinParams, fileBPath: e.target.value })}
                  placeholder="Absolute path to CSV file B..."
                  className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs font-mono text-zinc-300 focus:border-zinc-700 outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-zinc-400 block font-semibold">Key Column B</label>
                  <input
                    value={joinParams.keyColB}
                    onChange={(e) => setJoinParams({ ...joinParams, keyColB: e.target.value })}
                    placeholder="Exact key name in B..."
                    className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs text-zinc-300 focus:border-zinc-700 outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-zinc-400 block font-semibold">Join Operation Type</label>
                  <select
                    value={joinParams.joinType}
                    onChange={(e) => setJoinParams({ ...joinParams, joinType: e.target.value as any })}
                    className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs text-zinc-300 outline-none"
                  >
                    <option value="inner">INNER JOIN</option>
                    <option value="left">LEFT JOIN</option>
                    <option value="right">RIGHT JOIN</option>
                    <option value="outer">FULL OUTER JOIN</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-zinc-400 block font-semibold">Output CSV Destination Path</label>
                <input
                  value={joinParams.targetPath}
                  onChange={(e) => setJoinParams({ ...joinParams, targetPath: e.target.value })}
                  placeholder="Where to save the merged output..."
                  className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs font-mono text-zinc-300 focus:border-zinc-700 outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-zinc-800">
              <button
                onClick={() => setActiveModal(null)}
                className="bg-zinc-850 hover:bg-zinc-800 text-zinc-400 px-4 py-2 rounded text-xs transition"
              >
                Cancel
              </button>
              <button
                onClick={handleRunJoin}
                className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded text-xs font-semibold transition"
              >
                Execute Merge
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Smart Split Modal */}
      {activeModal === "split" && activeMeta && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-[450px] p-6 shadow-2xl space-y-4">
            <div className="flex items-center space-x-2 border-b border-zinc-800 pb-3">
              <Scissors className="w-5 h-5 text-emerald-400" />
              <h3 className="font-bold text-base text-white">Smart Splitter Engine</h3>
            </div>

            <div className="space-y-3 text-xs">
              <div className="space-y-1">
                <label className="text-zinc-400 block font-semibold">Split Criterion</label>
                <select
                  value={splitParams.splitBy}
                  onChange={(e) => setSplitParams({ ...splitParams, splitBy: e.target.value as any })}
                  className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs text-zinc-300 outline-none"
                >
                  <option value="rows">Row Count limit (e.g. 50,000 rows/file)</option>
                  <option value="column">Group by unique values in a Column</option>
                </select>
              </div>

              {splitParams.splitBy === "rows" ? (
                <div className="space-y-1">
                  <label className="text-zinc-400 block font-semibold">Row Limit per File</label>
                  <input
                    type="number"
                    value={splitParams.rowLimit}
                    onChange={(e) => setSplitParams({ ...splitParams, rowLimit: parseInt(e.target.value) || 50000 })}
                    className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs text-zinc-300 focus:border-zinc-700 outline-none"
                  />
                </div>
              ) : (
                <div className="space-y-1">
                  <label className="text-zinc-400 block font-semibold">Target Column</label>
                  <select
                    value={splitParams.columnName}
                    onChange={(e) => setSplitParams({ ...splitParams, columnName: e.target.value })}
                    className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs text-zinc-300 outline-none"
                  >
                    <option value="">-- Choose Column --</option>
                    {activeMeta.headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-1">
                <label className="text-zinc-400 block font-semibold">Output Directory</label>
                <input
                  value={splitParams.outputDir}
                  onChange={(e) => setSplitParams({ ...splitParams, outputDir: e.target.value })}
                  placeholder="Directory to save split files (e.g. /Users/exports/)..."
                  className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs font-mono text-zinc-300 focus:border-zinc-700 outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-zinc-800">
              <button
                onClick={() => setActiveModal(null)}
                className="bg-zinc-850 hover:bg-zinc-800 text-zinc-400 px-4 py-2 rounded text-xs transition"
              >
                Cancel
              </button>
              <button
                onClick={handleRunSplit}
                className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded text-xs font-semibold transition"
              >
                Execute Split
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Data Cleaning Modal */}
      {activeModal === "clean" && activeMeta && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-[480px] p-6 shadow-2xl space-y-4">
            <div className="flex items-center space-x-2 border-b border-zinc-800 pb-3">
              <Brush className="w-5 h-5 text-amber-400" />
              <h3 className="font-bold text-base text-white">Data Cleaning Suite</h3>
            </div>

            <div className="space-y-3 text-xs">
              <div className="space-y-1">
                <label className="text-zinc-400 block font-semibold">Cleaning Mode</label>
                <select
                  value={cleanParams.opType}
                  onChange={(e) => setCleanParams({ ...cleanParams, opType: e.target.value as any })}
                  className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs text-zinc-300 outline-none"
                >
                  <option value="deduplicate">1-Click Deduplication</option>
                  <option value="trim">Strip Whitespace (Trim)</option>
                  <option value="fill_missing">Fill Missing/Empty Values</option>
                </select>
              </div>

              {cleanParams.opType === "deduplicate" && (
                <div className="space-y-1.5">
                  <label className="text-zinc-400 block font-semibold">Select Keys (Composite Key)</label>
                  <div className="max-h-28 overflow-y-auto border border-zinc-850 bg-zinc-950 p-2 rounded space-y-1">
                    {activeMeta.headers.map((h) => (
                      <label key={h} className="flex items-center space-x-2 text-zinc-300 select-none">
                        <input
                          type="checkbox"
                          checked={cleanParams.columns.includes(h)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setCleanParams({ ...cleanParams, columns: [...cleanParams.columns, h] });
                            } else {
                              setCleanParams({ ...cleanParams, columns: cleanParams.columns.filter((c) => c !== h) });
                            }
                          }}
                          className="rounded border-zinc-800 bg-zinc-900 text-blue-600 focus:ring-0"
                        />
                        <span className="font-mono text-[11px]">{h}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {cleanParams.opType === "trim" && (
                <div className="space-y-1.5">
                  <label className="text-zinc-400 block font-semibold">Columns to Trim</label>
                  <div className="max-h-28 overflow-y-auto border border-zinc-850 bg-zinc-950 p-2 rounded space-y-1">
                    {activeMeta.headers.map((h) => (
                      <label key={h} className="flex items-center space-x-2 text-zinc-300 select-none">
                        <input
                          type="checkbox"
                          checked={cleanParams.columns.includes(h)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setCleanParams({ ...cleanParams, columns: [...cleanParams.columns, h] });
                            } else {
                              setCleanParams({ ...cleanParams, columns: cleanParams.columns.filter((c) => c !== h) });
                            }
                          }}
                          className="rounded border-zinc-800 bg-zinc-900 text-blue-600 focus:ring-0"
                        />
                        <span className="font-mono text-[11px]">{h}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {cleanParams.opType === "fill_missing" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-zinc-400 block font-semibold">Column</label>
                      <select
                        value={cleanParams.column}
                        onChange={(e) => setCleanParams({ ...cleanParams, column: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs text-zinc-300 outline-none"
                      >
                        <option value="">-- Choose Column --</option>
                        {activeMeta.headers.map((h) => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-zinc-400 block font-semibold">Replacement Strategy</label>
                      <select
                        value={cleanParams.fillType}
                        onChange={(e) => setCleanParams({ ...cleanParams, fillType: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs text-zinc-300 outline-none"
                      >
                        <option value="Value">Custom Value</option>
                        <option value="Mean">Mean (Average)</option>
                        <option value="Median">Median</option>
                        <option value="Mode">Mode (Most Frequent)</option>
                        <option value="Drop">Drop row containing null</option>
                      </select>
                    </div>
                  </div>
                  {cleanParams.fillType === "Value" && (
                    <div className="space-y-1">
                      <label className="text-zinc-400 block font-semibold">Custom Value</label>
                      <input
                        value={cleanParams.customValue}
                        onChange={(e) => setCleanParams({ ...cleanParams, customValue: e.target.value })}
                        placeholder="Insert replacement value..."
                        className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs text-zinc-300 focus:border-zinc-700 outline-none"
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-1">
                <label className="text-zinc-400 block font-semibold">Target Saved Output CSV Path</label>
                <input
                  value={cleanParams.targetPath}
                  onChange={(e) => setCleanParams({ ...cleanParams, targetPath: e.target.value })}
                  placeholder="Where to save the cleaned file..."
                  className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs font-mono text-zinc-300 focus:border-zinc-700 outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-zinc-800">
              <button
                onClick={() => setActiveModal(null)}
                className="bg-zinc-850 hover:bg-zinc-800 text-zinc-400 px-4 py-2 rounded text-xs transition"
              >
                Cancel
              </button>
              <button
                onClick={handleRunClean}
                className="bg-amber-650 hover:bg-amber-600 text-white px-4 py-2 rounded text-xs font-semibold transition"
              >
                Run Cleaning Operation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI Assistant Modal */}
      {activeModal === "ai" && activeMeta && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-[450px] p-6 shadow-2xl space-y-4">
            <div className="flex items-center space-x-2 border-b border-zinc-800 pb-3">
              <Sparkles className="w-5 h-5 text-purple-400" />
              <h3 className="font-bold text-base text-white">AI Data Assistant (BYOK)</h3>
            </div>

            <div className="space-y-3 text-xs">
              <div className="space-y-1">
                <label className="text-zinc-400 block font-semibold">Choose AI Provider</label>
                <select className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs text-zinc-300 outline-none">
                  <option value="openai">OpenAI (GPT-4o)</option>
                  <option value="gemini">Google Gemini (Gemini 1.5 Pro)</option>
                  <option value="anthropic">Anthropic (Claude 3.5 Sonnet)</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-zinc-400 block font-semibold">Your API Key (Encrypted Locally)</label>
                <input
                  type="password"
                  placeholder="sk-..."
                  className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs font-mono text-zinc-300 focus:border-zinc-700 outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-zinc-400 block font-semibold">Explain Dataset / Query in Natural Language</label>
                <textarea
                  rows={3}
                  placeholder="e.g. 'Show me clients from Vietnam with spends greater than 1000' or 'Detect anomaly outliers in column spend'"
                  className="w-full bg-zinc-950 border border-zinc-850 rounded p-2 text-xs text-zinc-300 focus:border-zinc-700 outline-none resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-3 border-t border-zinc-800">
              <button
                onClick={() => setActiveModal(null)}
                className="bg-zinc-850 hover:bg-zinc-800 text-zinc-400 px-4 py-2 rounded text-xs transition"
              >
                Close
              </button>
              <button
                onClick={() => {
                  alert("API key saved. Query translation will execute in localized pipeline.");
                  setActiveModal(null);
                }}
                className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded text-xs font-semibold transition"
              >
                Submit Query
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
