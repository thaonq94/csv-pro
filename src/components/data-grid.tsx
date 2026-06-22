"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { getCsvRows, updateCsvCell, CsvMetadata, FilterRule, getColumnUniqueValues, sortCsvColumn } from "@/lib/tauri";
import { Filter, ArrowUp, ArrowDown, Search, Check, X, ArrowUpAZ, ArrowDownZA } from "lucide-react";

interface DataGridProps {
  metadata: CsvMetadata;
  onMetadataUpdate: () => void;
  activeChanges: Record<number, Record<string, string>>;
  onCellDirty: (rowIdx: number, colName: string, value: string) => void;
  searchQuery?: string;
  filterVersion?: number;
  isFiltering?: boolean;
  rules?: FilterRule[];
  onRulesChange?: (rules: FilterRule[]) => void;
  onApplyFilter?: (rules?: FilterRule[]) => void;
}

const ROW_HEIGHT = 32;
const COL_WIDTH = 150;
const CHUNK_SIZE = 100; // fetch chunks of 100 rows

export const DataGrid: React.FC<DataGridProps> = ({
  metadata,
  onMetadataUpdate,
  activeChanges,
  onCellDirty,
  searchQuery = "",
  filterVersion = 0,
  isFiltering = false,
  rules = [],
  onRulesChange,
  onApplyFilter
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);
  const [containerWidth, setContainerWidth] = useState(1000);

  // Keyboard navigation & Editing states
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [editingCell, setEditingCell] = useState<{ row: number; col: number; val: string } | null>(null);

  // Excel-like filter and sorting states
  const [gridKeyVersion, setGridKeyVersion] = useState(0);
  const [sortState, setSortState] = useState<{ column: string; descending: boolean } | null>(null);
  const [activeFilterDropdown, setActiveFilterDropdown] = useState<{
    columnName: string;
    x: number;
    y: number;
  } | null>(null);
  const [columnUniqueValues, setColumnUniqueValues] = useState<string[]>([]);
  const [checkedValues, setCheckedValues] = useState<Record<string, boolean>>({});
  const [searchText, setSearchText] = useState("");
  const [loadingUnique, setLoadingUnique] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Column resizing state
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});

  const columnOffsets = useMemo(() => {
    const offsets: number[] = [];
    let currentOffset = 0;
    for (let i = 0; i < metadata.headers.length; i++) {
      offsets.push(currentOffset);
      const colName = metadata.headers[i];
      const width = columnWidths[colName] ?? 150;
      currentOffset += width;
    }
    return { offsets, totalWidth: currentOffset };
  }, [metadata.headers, columnWidths]);

  // In-memory cache of loaded rows: chunkIndex -> rows
  const [rowCache, setRowCache] = useState<Record<number, string[][]>>({});
  const [pendingFetches, setPendingFetches] = useState<Record<number, boolean>>({});

  const rowCacheRef = useRef<Record<number, string[][]>>({});
  const pendingFetchesRef = useRef<Record<number, boolean>>({});

  useEffect(() => {
    rowCacheRef.current = rowCache;
  }, [rowCache]);

  useEffect(() => {
    pendingFetchesRef.current = pendingFetches;
  }, [pendingFetches]);

  // Dynamic sizing listener
  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        setContainerHeight(entry.contentRect.height);
        setContainerWidth(entry.contentRect.width);
      }
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // Invalidate cache when file metadata/id changes, filter is updated, or sorting is applied
  useEffect(() => {
    setRowCache({});
    setPendingFetches({});
    rowCacheRef.current = {};
    pendingFetchesRef.current = {};
    setSelectedCell(null);
    setEditingCell(null);
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
      containerRef.current.scrollLeft = 0;
      setScrollTop(0);
      setScrollLeft(0);
    }
  }, [metadata.file_id, filterVersion, gridKeyVersion]);

  // Click outside handler for column filter dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setActiveFilterDropdown(null);
      }
    };
    if (activeFilterDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [activeFilterDropdown]);

  // Reset sortState on tab switch
  useEffect(() => {
    setSortState(null);
  }, [metadata.file_id]);

  // Fetch unique column values when dropdown is opened
  useEffect(() => {
    if (!activeFilterDropdown) return;
    const colName = activeFilterDropdown.columnName;
    setSearchText("");
    setLoadingUnique(true);
    
    const activeRules = rules || [];

    getColumnUniqueValues(metadata.file_id, colName)
      .then((vals) => {
        setColumnUniqueValues(vals);
        // Find existing rule on this column
        const rule = activeRules.find((r) => r.column === colName);
        if (rule && rule.operator === "in") {
          try {
            const allowed = JSON.parse(rule.value) as string[];
            const map: Record<string, boolean> = {};
            vals.forEach((v) => {
              map[v] = allowed.includes(v);
            });
            setCheckedValues(map);
          } catch {
            const map: Record<string, boolean> = {};
            vals.forEach((v) => {
              map[v] = true;
            });
            setCheckedValues(map);
          }
        } else {
          // default to all checked
          const map: Record<string, boolean> = {};
          vals.forEach((v) => {
            map[v] = true;
          });
          setCheckedValues(map);
        }
      })
      .catch((err) => console.error("Error fetching column unique values:", err))
      .finally(() => setLoadingUnique(false));
  }, [activeFilterDropdown, metadata.file_id, rules]);

  // Sorting handler
  const handleSort = async (columnName: string, descending: boolean) => {
    try {
      await sortCsvColumn(metadata.file_id, columnName, descending);
      setSortState({ column: columnName, descending });
      setGridKeyVersion((v) => v + 1);
      setActiveFilterDropdown(null);
    } catch (err) {
      alert(`Sort failed: ${err}`);
    }
  };

  // Applying column filters
  const handleApplyDropdownFilter = () => {
    if (!activeFilterDropdown || !onRulesChange || !onApplyFilter) return;
    const colName = activeFilterDropdown.columnName;
    const activeRules = rules || [];

    let newRules = activeRules.filter((r) => r.column !== colName);

    const checked = columnUniqueValues.filter((v) => checkedValues[v]);
    
    if (checked.length < columnUniqueValues.length) {
      newRules.push({
        column: colName,
        operator: "in",
        value: JSON.stringify(checked)
      });
    }

    onRulesChange(newRules);
    onApplyFilter(newRules);
    setActiveFilterDropdown(null);
  };

  // Clear column-specific filter
  const handleClearColumnFilter = () => {
    if (!activeFilterDropdown || !onRulesChange || !onApplyFilter) return;
    const colName = activeFilterDropdown.columnName;
    const activeRules = rules || [];

    let newRules = activeRules.filter((r) => r.column !== colName);

    onRulesChange(newRules);
    onApplyFilter(newRules);
    setActiveFilterDropdown(null);
  };

  // Invalidate cache once when indexing finishes to guarantee final indexes are loaded
  const prevIndexingComplete = useRef(metadata.indexing_complete);
  useEffect(() => {
    if (metadata.indexing_complete && !prevIndexingComplete.current) {
      setRowCache({});
      setPendingFetches({});
      rowCacheRef.current = {};
      pendingFetchesRef.current = {};
    }
    prevIndexingComplete.current = metadata.indexing_complete;
  }, [metadata.indexing_complete]);

  // Handle Scroll updates
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    setScrollTop(target.scrollTop);
    setScrollLeft(target.scrollLeft);
  };

  // Double-axis window coordinates
  const MAX_SCROLL_HEIGHT = 15000000; // 15 million pixels is a safe layout ceiling
  const totalHeight = metadata.total_rows * ROW_HEIGHT;
  const needsScaling = totalHeight > MAX_SCROLL_HEIGHT;
  const scrollableHeight = needsScaling ? MAX_SCROLL_HEIGHT : totalHeight;

  const maxScrollableScroll = Math.max(1, scrollableHeight - containerHeight);
  const maxRealScroll = Math.max(1, totalHeight - containerHeight);
  const scale = needsScaling ? maxRealScroll / maxScrollableScroll : 1;

  const realScrollTop = scrollTop * scale;

  const visibleStartRow = Math.max(0, Math.floor(realScrollTop / ROW_HEIGHT) - 5);
  const visibleEndRow = Math.min(
    metadata.total_rows,
    Math.ceil((realScrollTop + containerHeight) / ROW_HEIGHT) + 5
  );

  const { visibleStartCol, visibleEndCol } = useMemo(() => {
    let start = 0;
    for (let i = 0; i < metadata.headers.length; i++) {
      const colWidth = columnWidths[metadata.headers[i]] ?? 150;
      if (columnOffsets.offsets[i] + colWidth >= scrollLeft) {
        start = Math.max(0, i - 2);
        break;
      }
    }
    let end = metadata.headers.length;
    for (let i = start; i < metadata.headers.length; i++) {
      if (columnOffsets.offsets[i] > scrollLeft + containerWidth) {
        end = Math.min(metadata.headers.length, i + 2);
        break;
      }
    }
    return { visibleStartCol: start, visibleEndCol: end };
  }, [scrollLeft, containerWidth, columnOffsets, metadata.headers, columnWidths]);

  // Identify which chunks are needed based on visible rows
  useEffect(() => {
    const startChunk = Math.floor(visibleStartRow / CHUNK_SIZE);
    const endChunk = Math.floor(visibleEndRow / CHUNK_SIZE);

    for (let chunkIdx = startChunk; chunkIdx <= endChunk; chunkIdx++) {
      if (rowCacheRef.current[chunkIdx] || pendingFetchesRef.current[chunkIdx]) continue;

      // Mark as pending
      setPendingFetches((prev) => ({ ...prev, [chunkIdx]: true }));
      pendingFetchesRef.current[chunkIdx] = true;

      const offset = chunkIdx * CHUNK_SIZE;
      const limit = CHUNK_SIZE;

      getCsvRows(metadata.file_id, offset, limit)
        .then((fetchedRows) => {
          const isFullChunk = fetchedRows.length === limit;
          if (isFullChunk || metadata.indexing_complete) {
            setRowCache((prev) => ({ ...prev, [chunkIdx]: fetchedRows }));
            rowCacheRef.current[chunkIdx] = fetchedRows;
          }
        })
        .catch((err) => console.error("Error fetching rows from engine:", err))
        .finally(() => {
          setPendingFetches((prev) => {
            const next = { ...prev };
            delete next[chunkIdx];
            return next;
          });
          delete pendingFetchesRef.current[chunkIdx];
        });
    }
  }, [visibleStartRow, visibleEndRow, metadata.file_id, filterVersion, metadata.indexing_complete]);

  // Read cell value helper, overlaying cache + local changes
  const getCellValue = (rowIdx: number, colIdx: number): string => {
    const colName = metadata.headers[colIdx];
    // Check local uncommitted edits
    if (activeChanges[rowIdx]?.[colName] !== undefined) {
      return activeChanges[rowIdx][colName];
    }
    const chunkIdx = Math.floor(rowIdx / CHUNK_SIZE);
    const relativeRowIdx = rowIdx % CHUNK_SIZE;
    const chunk = rowCache[chunkIdx];
    return chunk?.[relativeRowIdx]?.[colIdx] ?? "";
  };

  // Keyboard navigation listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedCell) return;
      if (editingCell) return; // ignore when typing

      let { row, col } = selectedCell;

      switch (e.key) {
        case "ArrowUp":
          if (row > 0) setSelectedCell({ row: row - 1, col });
          e.preventDefault();
          break;
        case "ArrowDown":
          if (row < metadata.total_rows - 1) setSelectedCell({ row: row + 1, col });
          e.preventDefault();
          break;
        case "ArrowLeft":
          if (col > 0) setSelectedCell({ row, col: col - 1 });
          e.preventDefault();
          break;
        case "ArrowRight":
          if (col < metadata.headers.length - 1) setSelectedCell({ row, col: col + 1 });
          e.preventDefault();
          break;
        case "Enter":
          setEditingCell({
            row,
            col,
            val: getCellValue(row, col)
          });
          e.preventDefault();
          break;
        case "Backspace":
        case "Delete":
          const colName = metadata.headers[col];
          onCellDirty(row, colName, "");
          updateCsvCell(metadata.file_id, row, colName, "").catch(console.error);
          e.preventDefault();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedCell, editingCell, metadata, rowCache, activeChanges]);

  // Apply cell updates
  const saveCellEdit = () => {
    if (!editingCell) return;
    const { row, col, val } = editingCell;
    const colName = metadata.headers[col];
    
    // Save locally
    onCellDirty(row, colName, val);
    
    // Save to Rust engine delta map
    updateCsvCell(metadata.file_id, row, colName, val)
      .then(() => onMetadataUpdate())
      .catch((err) => console.error("Tauri cell edit error: ", err));

    setEditingCell(null);
  };

  const handleResizeStart = (e: React.MouseEvent, colName: string) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startWidth = columnWidths[colName] ?? 150;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      setColumnWidths((prev) => ({
        ...prev,
        [colName]: Math.max(50, startWidth + deltaX),
      }));
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  // Scroll to selected cell if viewport changes
  useEffect(() => {
    if (!selectedCell || !containerRef.current) return;
    const targetTop = selectedCell.row * ROW_HEIGHT;
    const targetLeft = columnOffsets.offsets[selectedCell.col];
    const targetWidth = columnWidths[metadata.headers[selectedCell.col]] ?? 150;

    const cont = containerRef.current;
    if (targetTop < realScrollTop) {
      cont.scrollTop = needsScaling ? targetTop / scale : targetTop;
    } else if (targetTop + ROW_HEIGHT > realScrollTop + containerHeight) {
      cont.scrollTop = needsScaling ? (targetTop - containerHeight + ROW_HEIGHT + 30) / scale : targetTop - containerHeight + ROW_HEIGHT + 30; // buffer scroll
    }

    if (targetLeft < cont.scrollLeft) {
      cont.scrollLeft = targetLeft;
    } else if (targetLeft + targetWidth > cont.scrollLeft + containerWidth) {
      cont.scrollLeft = targetLeft - containerWidth + targetWidth + 50;
    }
  }, [selectedCell, columnOffsets, columnWidths, metadata, realScrollTop, containerHeight, containerWidth, needsScaling, scale]);

  // Generate grid cells
  const renderedCells = useMemo(() => {
    const cells = [];
    
    // Render row index headers (left sticky simulation offset)
    for (let r = visibleStartRow; r < visibleEndRow; r++) {
      const isDirtyRow = activeChanges[r] !== undefined;
      const topPos = r * ROW_HEIGHT - (realScrollTop - scrollTop);
      cells.push(
        <div
          key={`row-header-${r}`}
          style={{
            position: "absolute",
            top: topPos,
            left: 0,
            width: 50,
            height: ROW_HEIGHT,
          }}
          className={`flex items-center justify-center border-r border-b text-[11px] font-mono select-none bg-zinc-900 border-zinc-800 text-zinc-500 font-semibold ${
            isDirtyRow ? "border-l-4 border-l-orange-500 pl-1" : ""
          }`}
        >
          {r + 1}
        </div>
      );
    }

    // Render cells in double virtual viewport
    for (let r = visibleStartRow; r < visibleEndRow; r++) {
      for (let c = visibleStartCol; c < visibleEndCol; c++) {
        const colName = metadata.headers[c];
        const val = getCellValue(r, c);
        const isSelected = selectedCell?.row === r && selectedCell?.col === c;
        const isEditing = editingCell?.row === r && editingCell?.col === c;
        const isDirtyCell = activeChanges[r]?.[colName] !== undefined;
        const colWidth = columnWidths[colName] ?? 150;
        const topPos = r * ROW_HEIGHT - (realScrollTop - scrollTop);
        cells.push(
          <div
            key={`cell-${r}-${c}`}
            onClick={() => {
              setSelectedCell({ row: r, col: c });
            }}
            onDoubleClick={() => {
              setEditingCell({ row: r, col: c, val });
            }}
            style={{
              position: "absolute",
              top: topPos,
              left: 50 + columnOffsets.offsets[c],
              width: colWidth,
              height: ROW_HEIGHT,
            }}
            className={`border-r border-b border-zinc-800 text-xs flex items-center px-2 select-none overflow-hidden text-ellipsis whitespace-nowrap cursor-default ${
              isSelected ? "bg-zinc-800/40 ring-2 ring-blue-500/80 z-20" : ""
            } ${isDirtyCell ? "grid-cell-dirty" : ""} bg-zinc-950/20`}
          >
            {isEditing ? (
              <input
                autoFocus
                className="w-full h-full bg-zinc-900 text-foreground border-none outline-none px-1 py-0.5 rounded font-mono text-xs text-white"
                value={editingCell.val}
                onChange={(e) => setEditingCell({ ...editingCell, val: e.target.value })}
                onBlur={saveCellEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveCellEdit();
                  if (e.key === "Escape") setEditingCell(null);
                }}
              />
            ) : (
              <span className="font-mono text-zinc-300 truncate w-full">{val}</span>
            )}
          </div>
        );
      }
    }

    return cells;
  }, [
    visibleStartRow,
    visibleEndRow,
    visibleStartCol,
    visibleEndCol,
    selectedCell,
    editingCell,
    rowCache,
    activeChanges,
    metadata,
    columnWidths,
    columnOffsets,
    realScrollTop,
    scrollTop
  ]);

  return (
    <div className="flex flex-col w-full h-full bg-zinc-950 select-none">
      {/* Grid Headers Row */}
      <div className="flex h-9 bg-zinc-900 border-b border-zinc-800 select-none overflow-hidden relative">
        {/* Empty left top corner block */}
        <div className="w-[50px] shrink-0 border-r border-zinc-800 bg-zinc-900 flex items-center justify-center font-bold font-mono text-[10px] text-zinc-600">
          IDX
        </div>
        
        {/* Virtualized Headers Container */}
        <div className="flex relative w-full h-full" style={{ transform: `translateX(-${scrollLeft}px)` }}>
          {metadata.headers.map((header, idx) => {
            const colSchema = metadata.columns.find((col) => col.name === header);
            const dataType = colSchema?.data_type ?? "String";
            const colWidth = columnWidths[header] ?? 150;

            const hasFilter = (rules || []).some((r) => r.column === header);
            const isSorted = sortState?.column === header;
            const isDescending = sortState?.descending;

            return (
              <div
                key={`header-${idx}`}
                style={{
                  position: "absolute",
                  left: columnOffsets.offsets[idx],
                  width: colWidth,
                  height: 36,
                }}
                className="flex items-center justify-between px-3 border-r border-zinc-800 hover:bg-zinc-850/30 select-none group relative"
              >
                {/* Header title text & sort icon */}
                <div 
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const containerRect = containerRef.current?.getBoundingClientRect();
                    if (containerRect) {
                      setActiveFilterDropdown({
                        columnName: header,
                        x: rect.left - containerRect.left,
                        y: 36
                      });
                    }
                  }}
                  className="flex items-center space-x-1.5 truncate cursor-pointer flex-1 min-w-0 pr-1 py-1"
                >
                  <span className="text-xs font-semibold text-zinc-200 truncate">{header}</span>
                  {isSorted && (
                    isDescending ? (
                      <ArrowDown className="w-3 h-3 text-blue-500 shrink-0" />
                    ) : (
                      <ArrowUp className="w-3 h-3 text-blue-500 shrink-0" />
                    )
                  )}
                </div>

                {/* Filter button + type badge */}
                <div className="flex items-center space-x-1 shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const containerRect = containerRef.current?.getBoundingClientRect();
                      if (containerRect) {
                        setActiveFilterDropdown({
                          columnName: header,
                          x: rect.left - containerRect.left,
                          y: 36
                        });
                      }
                    }}
                    className={`p-1 rounded hover:bg-zinc-800 transition-colors ${
                      hasFilter
                        ? "bg-blue-600/20 text-blue-400 opacity-100"
                        : "text-zinc-500 hover:text-zinc-300 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    }`}
                  >
                    <Filter className="w-3 h-3" />
                  </button>
                  
                  <span className="text-[9px] px-1 py-0.2 bg-zinc-950 text-zinc-500 rounded border border-zinc-800 font-mono scale-90 select-none">
                    {dataType === "Numeric" ? "#" : dataType === "Boolean" ? "Y/N" : dataType === "Datetime" ? "📅" : "A"}
                  </span>
                </div>

                {/* Resize Handle */}
                <div
                  onMouseDown={(e) => handleResizeStart(e, header)}
                  className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-500 bg-transparent transition-colors z-30"
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Grid Scroll Body */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto relative select-none w-full scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent"
      >
        <div
          style={{
            height: scrollableHeight,
            width: 50 + columnOffsets.totalWidth,
            position: "relative",
          }}
          className="bg-zinc-950/10 pointer-events-auto"
        >
          {renderedCells}
        </div>

        {/* Premium Loading Overlay */}
        {isFiltering && (
          <div className="absolute inset-0 bg-zinc-950/45 backdrop-blur-[1px] flex items-center justify-center z-50 pointer-events-none transition-all">
            <div className="flex flex-col items-center space-y-3 px-5 py-3 bg-zinc-900/90 border border-zinc-800/80 rounded-xl shadow-2xl backdrop-blur-md">
              <div className="w-6 h-6 border-2 border-blue-500/20 border-t-blue-500 rounded-full animate-spin" />
              <div className="text-[10px] font-bold text-zinc-400 tracking-wider font-mono">
                APPLYING FILTERS...
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floating Excel-like Filter/Sort Popover */}
      {activeFilterDropdown && (
        <div
          ref={dropdownRef}
          style={{
            position: "absolute",
            left: Math.min(activeFilterDropdown.x, containerWidth - 250), // prevent going off screen right
            top: activeFilterDropdown.y + 4,
            zIndex: 100,
          }}
          className="w-60 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-3 flex flex-col text-xs text-zinc-200 select-none animate-fade-in"
        >
          {/* Header Action Buttons */}
          <div className="flex flex-col space-y-1.5 pb-2 border-b border-zinc-800">
            <button
              onClick={() => handleSort(activeFilterDropdown.columnName, false)}
              className="flex items-center space-x-2 w-full px-2 py-1.5 hover:bg-zinc-800/80 rounded transition text-left text-zinc-300 hover:text-white"
            >
              <ArrowUpAZ className="w-3.5 h-3.5 text-blue-500" />
              <span>Sort A to Z (Ascending)</span>
            </button>
            <button
              onClick={() => handleSort(activeFilterDropdown.columnName, true)}
              className="flex items-center space-x-2 w-full px-2 py-1.5 hover:bg-zinc-800/80 rounded transition text-left text-zinc-300 hover:text-white"
            >
              <ArrowDownZA className="w-3.5 h-3.5 text-blue-500" />
              <span>Sort Z to A (Descending)</span>
            </button>
            {(rules || []).some((r) => r.column === activeFilterDropdown.columnName) && (
              <button
                onClick={handleClearColumnFilter}
                className="flex items-center space-x-2 w-full px-2 py-1.5 hover:bg-red-500/10 text-red-400 hover:text-red-300 rounded transition text-left"
              >
                <X className="w-3.5 h-3.5" />
                <span>Clear Filter from Column</span>
              </button>
            )}
          </div>

          {/* Search values */}
          <div className="pt-2 pb-1.5">
            <div className="relative">
              <Search className="absolute left-2 top-2 w-3.5 h-3.5 text-zinc-500" />
              <input
                type="text"
                placeholder="Search..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-md pl-7 pr-2 py-1.5 text-xs text-zinc-200 focus:border-zinc-700 outline-none placeholder:text-zinc-650"
              />
            </div>
          </div>

          {/* Checklist */}
          <div className="flex-1 min-h-[120px] max-h-48 overflow-y-auto pr-1 py-1 border-b border-zinc-800 scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent">
            {loadingUnique ? (
              <div className="flex flex-col items-center justify-center h-24 space-y-2 text-zinc-500">
                <div className="w-4 h-4 border border-blue-500/20 border-t-blue-500 rounded-full animate-spin" />
                <span className="text-[10px]">Loading values...</span>
              </div>
            ) : (
              (() => {
                const filtered = columnUniqueValues.filter((v) =>
                  (v === "" ? "(Blanks)" : v).toLowerCase().includes(searchText.toLowerCase())
                );
                
                const allVisibleChecked = filtered.every((v) => checkedValues[v]);
                const someVisibleChecked = filtered.some((v) => checkedValues[v]) && !allVisibleChecked;

                return (
                  <div className="space-y-1">
                    {/* Select All */}
                    <label className="flex items-center space-x-2 px-2 py-1 hover:bg-zinc-800/40 rounded cursor-pointer text-zinc-300 hover:text-white">
                      <input
                        type="checkbox"
                        checked={allVisibleChecked}
                        ref={(el) => {
                          if (el) el.indeterminate = someVisibleChecked;
                        }}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setCheckedValues((prev) => {
                            const next = { ...prev };
                            filtered.forEach((v) => {
                              next[v] = checked;
                            });
                            return next;
                          });
                        }}
                        className="rounded border-zinc-700 bg-zinc-950 text-blue-600 focus:ring-blue-500 focus:ring-offset-zinc-900 focus:ring-0 scale-95"
                      />
                      <span className="font-semibold select-none">Select All</span>
                    </label>

                    {/* Values */}
                    {filtered.map((val, idx) => (
                      <label
                        key={idx}
                        className="flex items-center space-x-2 px-2 py-0.5 hover:bg-zinc-800/40 rounded cursor-pointer text-zinc-400 hover:text-white"
                      >
                        <input
                          type="checkbox"
                          checked={!!checkedValues[val]}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setCheckedValues((prev) => ({
                              ...prev,
                              [val]: checked,
                            }));
                          }}
                          className="rounded border-zinc-700 bg-zinc-950 text-blue-600 focus:ring-blue-500 focus:ring-offset-zinc-900 focus:ring-0 scale-90"
                        />
                        <span className={`truncate select-none ${val === "" ? "italic text-zinc-500" : ""}`}>
                          {val === "" ? "(Blanks)" : val}
                        </span>
                      </label>
                    ))}
                    {filtered.length === 0 && (
                      <div className="text-center text-zinc-650 py-4 italic text-[11px]">
                        No matching values
                      </div>
                    )}
                  </div>
                );
              })()
            )}
          </div>

          {/* Footer buttons */}
          <div className="flex items-center justify-end space-x-2 pt-2">
            <button
              onClick={() => setActiveFilterDropdown(null)}
              className="px-2.5 py-1.5 border border-zinc-800 hover:bg-zinc-800 rounded font-semibold text-[10px] text-zinc-400 hover:text-white transition"
            >
              Cancel
            </button>
            <button
              onClick={handleApplyDropdownFilter}
              disabled={loadingUnique}
              className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 active:scale-95 text-white font-bold rounded text-[10px] transition disabled:opacity-50 disabled:pointer-events-none"
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
