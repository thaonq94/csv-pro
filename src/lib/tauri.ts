export const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_METADATA__ !== undefined;

export interface ColumnSchema {
  name: string;
  data_type: string;
}

export interface CsvMetadata {
  file_id: string;
  path: string;
  delimiter: string;
  encoding: string;
  headers: string[];
  total_rows: number;
  indexing_complete: boolean;
  columns: ColumnSchema[];
  total_bytes: number;
  indexed_bytes: number;
}

export async function selectCsvFile(): Promise<string | null> {
  if (!isTauri) {
    const path = prompt("Enter mock file path to open:", "/Users/thaonq/Desktop/workspace/sales_data.csv");
    return path;
  }
  try {
    const { open } = await import('@tauri-apps/api/dialog');
    const selected = await open({
      multiple: false,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (Array.isArray(selected)) {
      return selected[0] || null;
    }
    return selected;
  } catch (e) {
    console.error("Tauri dialog error:", e);
    return null;
  }
}

// Mock states for standard web browser debugging
let mockFiles: Record<string, {
  headers: string[];
  rows: string[][];
  meta: CsvMetadata;
}> = {};

export async function openCsvFile(path: string): Promise<CsvMetadata> {
  if (!isTauri) {
    console.warn("Running in browser. Simulating file load...");
    const fileId = Math.random().toString(36).substring(7);
    const headers = ["ID", "Name", "Email", "Country", "Spend", "Status", "Date Joined"];
    const rows = Array.from({ length: 25000 }, (_, i) => [
      String(i + 1),
      `Client ${i + 1}`,
      `client_${i + 1}@domain.com`,
      ["USA", "Vietnam", "UK", "Germany", "Japan", "Singapore"][i % 6],
      String(Math.floor(Math.random() * 15000)),
      i % 12 === 0 ? "Inactive" : "Active",
      `2026-06-${String((i % 30) + 1).padStart(2, '0')}`
    ]);
    
    const meta: CsvMetadata = {
      file_id: fileId,
      path: path,
      delimiter: ",",
      encoding: "UTF-8",
      headers,
      total_rows: rows.length,
      indexing_complete: true,
      columns: [
        { name: "ID", data_type: "Numeric" },
        { name: "Name", data_type: "String" },
        { name: "Email", data_type: "String" },
        { name: "Country", data_type: "String" },
        { name: "Spend", data_type: "Numeric" },
        { name: "Status", data_type: "String" },
        { name: "Date Joined", data_type: "Datetime" },
      ],
      total_bytes: 2 * 1024 * 1024,
      indexed_bytes: 2 * 1024 * 1024
    };
    mockFiles[fileId] = { headers, rows, meta };
    return new Promise(resolve => setTimeout(() => resolve(meta), 300));
  }
  const { invoke } = await import('@tauri-apps/api/tauri');
  return invoke<CsvMetadata>('open_csv_file', { path });
}

export async function getCsvRows(fileId: string, offset: number, limit: number): Promise<string[][]> {
  if (!isTauri) {
    const file = mockFiles[fileId];
    if (!file) return [];
    return file.rows.slice(offset, offset + limit);
  }
  const { invoke } = await import('@tauri-apps/api/tauri');
  return invoke<string[][]>('get_csv_rows', { fileId, offset, limit });
}

export async function updateCsvCell(
  fileId: string,
  rowIdx: number,
  colName: string,
  value: string
): Promise<void> {
  if (!isTauri) {
    const file = mockFiles[fileId];
    if (file) {
      const colIdx = file.headers.indexOf(colName);
      if (colIdx !== -1 && file.rows[rowIdx]) {
        file.rows[rowIdx][colIdx] = value;
      }
    }
    return;
  }
  const { invoke } = await import('@tauri-apps/api/tauri');
  return invoke<void>('update_csv_cell', { fileId, rowIdx, colName, value });
}

export async function getCsvMetadata(fileId: string): Promise<CsvMetadata> {
  if (!isTauri) {
    return mockFiles[fileId]?.meta;
  }
  const { invoke } = await import('@tauri-apps/api/tauri');
  return invoke<CsvMetadata>('get_csv_metadata', { fileId });
}

export async function saveCsvFile(fileId: string, targetPath: string): Promise<void> {
  if (!isTauri) {
    console.log(`Saved file ${fileId} mock to ${targetPath}`);
    return;
  }
  const { invoke } = await import('@tauri-apps/api/tauri');
  return invoke<void>('save_csv_file', { fileId, targetPath });
}

export async function applyCleaningOp(
  fileId: string,
  opType: 'deduplicate' | 'trim' | 'fill_missing',
  targetPath: string,
  params: any
): Promise<void> {
  if (!isTauri) {
    console.log(`Cleaning op ${opType} run mock-target ${targetPath}`);
    return;
  }
  const { invoke } = await import('@tauri-apps/api/tauri');
  return invoke<void>('apply_cleaning_op', { fileId, opType, targetPath, params });
}

export async function joinCsvFiles(
  fileIdA: string,
  keyColA: string,
  fileIdB: string,
  keyColB: string,
  joinType: 'inner' | 'left' | 'right' | 'outer',
  targetPath: string
): Promise<void> {
  if (!isTauri) {
    console.log(`Joined files ${fileIdA} and ${fileIdB} to ${targetPath} using ${joinType}`);
    return;
  }
  const { invoke } = await import('@tauri-apps/api/tauri');
  return invoke<void>('join_csv_files', { fileIdA, keyColA, fileIdB, keyColB, joinType, targetPath });
}

export async function splitCsvFile(
  fileId: string,
  splitBy: 'rows' | 'column',
  rowLimit: number | null,
  columnName: string | null,
  outputDir: string
): Promise<string[]> {
  if (!isTauri) {
    return [`${outputDir}/mock_part_1.csv`, `${outputDir}/mock_part_2.csv`];
  }
  const { invoke } = await import('@tauri-apps/api/tauri');
  return invoke<string[]>('split_csv_file', { fileId, splitBy, rowLimit, columnName, outputDir });
}

export interface FilterRule {
  column: string;
  operator: string;
  value: string;
}

export async function applyCsvFilter(
  fileId: string,
  rules: FilterRule[],
  conjunction: 'AND' | 'OR'
): Promise<number> {
  if (!isTauri) {
    console.warn("Running in browser. Simulating filter apply...");
    const file = mockFiles[fileId];
    if (file) {
      if (!(file as any).originalRows) {
        (file as any).originalRows = [...file.rows];
      }
      const filtered = (file as any).originalRows.filter((row: string[]) => {
        if (rules.length === 0) return true;
        const matches = rules.map(rule => {
          const colIdx = file.headers.indexOf(rule.column);
          if (colIdx === -1) return false;
          const val = row[colIdx] || "";
          switch (rule.operator) {
            case "equals": return val.toLowerCase() === rule.value.toLowerCase();
            case "contains": return val.toLowerCase().includes(rule.value.toLowerCase());
            case "starts_with": return val.toLowerCase().startsWith(rule.value.toLowerCase());
            case "ends_with": return val.toLowerCase().endsWith(rule.value.toLowerCase());
            case "is_empty": return val.trim() === "";
            case "regex": {
              try {
                return new RegExp(rule.value, "i").test(val);
              } catch {
                return false;
              }
            }
            case "eq": return parseFloat(val) === parseFloat(rule.value);
            case "ne": {
              const pVal = parseFloat(val);
              const pRule = parseFloat(rule.value);
              if (!isNaN(pVal) && !isNaN(pRule)) {
                return pVal !== pRule;
              }
              return val.toLowerCase() !== rule.value.toLowerCase();
            }
            case "gt": return parseFloat(val) > parseFloat(rule.value);
            case "lt": return parseFloat(val) < parseFloat(rule.value);
            default: return false;
          }
        });
        if (conjunction === "AND") {
          return matches.every(Boolean);
        } else {
          return matches.some(Boolean);
        }
      });
      file.rows = filtered;
      file.meta.total_rows = filtered.length;
      return filtered.length;
    }
    return 0;
  }
  const { invoke } = await import('@tauri-apps/api/tauri');
  return invoke<number>('apply_csv_filter', { fileId, rules, conjunction });
}

export async function clearCsvFilter(fileId: string): Promise<void> {
  if (!isTauri) {
    console.warn("Running in browser. Simulating filter clear...");
    const file = mockFiles[fileId];
    if (file && (file as any).originalRows) {
      file.rows = [...(file as any).originalRows];
      file.meta.total_rows = file.rows.length;
    }
    return;
  }
  const { invoke } = await import('@tauri-apps/api/tauri');
  return invoke<void>('clear_csv_filter', { fileId });
}

export async function getColumnUniqueValues(fileId: string, columnName: string): Promise<string[]> {
  if (!isTauri) {
    const file = mockFiles[fileId];
    if (!file) return [];
    const colIdx = file.headers.indexOf(columnName);
    if (colIdx === -1) return [];
    const sourceRows = (file as any).originalRows || file.rows;
    const unique: string[] = Array.from(new Set(sourceRows.map((r: string[]) => r[colIdx] || "")));
    const isNumeric = file.meta.columns.find(c => c.name === columnName)?.data_type === "Numeric";
    unique.sort((a: string, b: string) => {
      if (isNumeric) {
        const na = parseFloat(a);
        const nb = parseFloat(b);
        if (isNaN(na) && isNaN(nb)) return a.localeCompare(b);
        if (isNaN(na)) return 1;
        if (isNaN(nb)) return -1;
        return na - nb;
      }
      return a.localeCompare(b);
    });
    return unique;
  }
  const { invoke } = await import('@tauri-apps/api/tauri');
  return invoke<string[]>('get_column_unique_values', { fileId, columnName });
}

export async function sortCsvColumn(fileId: string, columnName: string, descending: boolean): Promise<void> {
  if (!isTauri) {
    const file = mockFiles[fileId];
    if (!file) return;
    const colIdx = file.headers.indexOf(columnName);
    if (colIdx === -1) return;
    const isNumeric = file.meta.columns.find(c => c.name === columnName)?.data_type === "Numeric";
    file.rows.sort((rowA: string[], rowB: string[]) => {
      const a = rowA[colIdx] || "";
      const b = rowB[colIdx] || "";
      if (isNumeric) {
        const na = parseFloat(a);
        const nb = parseFloat(b);
        if (isNaN(na) && isNaN(nb)) return a.localeCompare(b);
        if (isNaN(na)) return 1;
        if (isNaN(nb)) return -1;
        return descending ? nb - na : na - nb;
      }
      const cmp = a.localeCompare(b);
      return descending ? -cmp : cmp;
    });
    return;
  }
  const { invoke } = await import('@tauri-apps/api/tauri');
  return invoke<void>('sort_csv_column', { fileId, columnName, descending });
}
