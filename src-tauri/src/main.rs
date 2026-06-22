#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod csv_engine;

use csv_engine::{CsvEngine, CsvMetadata, FilterRule};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;
use uuid::Uuid;

pub struct AppState {
    pub engines: Arc<Mutex<HashMap<String, Arc<CsvEngine>>>>,
}

#[tauri::command]
fn open_csv_file(state: State<AppState>, path: String) -> Result<CsvMetadata, String> {
    let file_id = Uuid::new_v4().to_string();
    let engine = Arc::new(CsvEngine::new(file_id.clone(), &path)?);
    
    let metadata = engine.get_metadata();
    
    let mut engines = state.engines.lock().unwrap();
    engines.insert(file_id, engine);
    
    Ok(metadata)
}

#[tauri::command]
fn get_csv_rows(
    state: State<AppState>,
    file_id: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<Vec<String>>, String> {
    let engine = {
        let engines = state.engines.lock().unwrap();
        engines.get(&file_id).cloned()
    };
    
    match engine {
        Some(e) => e.get_rows(offset, limit),
        None => Err("File not opened or session expired".to_string()),
    }
}

#[tauri::command]
fn update_csv_cell(
    state: State<AppState>,
    file_id: String,
    row_idx: usize,
    col_name: String,
    value: String,
) -> Result<(), String> {
    let engine = {
        let engines = state.engines.lock().unwrap();
        engines.get(&file_id).cloned()
    };
    
    match engine {
        Some(e) => {
            e.update_cell(row_idx, col_name, value);
            Ok(())
        }
        None => Err("File not opened or session expired".to_string()),
    }
}

#[tauri::command]
fn get_csv_metadata(state: State<AppState>, file_id: String) -> Result<CsvMetadata, String> {
    let engine = {
        let engines = state.engines.lock().unwrap();
        engines.get(&file_id).cloned()
    };
    
    match engine {
        Some(e) => Ok(e.get_metadata()),
        None => Err("File not opened or session expired".to_string()),
    }
}

#[tauri::command]
async fn save_csv_file(state: State<'_, AppState>, file_id: String, target_path: String) -> Result<(), String> {
    let engine = {
        let engines = state.engines.lock().unwrap();
        engines.get(&file_id).cloned()
    };
    
    match engine {
        Some(e) => e.save_file(&target_path),
        None => Err("File not opened or session expired".to_string()),
    }
}

#[tauri::command]
async fn apply_cleaning_op(
    state: State<'_, AppState>,
    file_id: String,
    op_type: String, // "deduplicate" | "trim" | "fill_missing"
    target_path: String,
    params: serde_json::Value,
) -> Result<(), String> {
    let engine = {
        let engines = state.engines.lock().unwrap();
        engines.get(&file_id).cloned()
    };
    
    let engine = match engine {
        Some(e) => e,
        None => return Err("File not opened".to_string()),
    };

    match op_type.as_str() {
        "deduplicate" => {
            let cols: Vec<String> = serde_json::from_value(params.get("columns").cloned().unwrap_or_default())
                .map_err(|e| e.to_string())?;
            engine.deduplicate(cols, &target_path)?;
        }
        "trim" => {
            let cols: Vec<String> = serde_json::from_value(params.get("columns").cloned().unwrap_or_default())
                .map_err(|e| e.to_string())?;
            engine.trim_whitespace(cols, &target_path)?;
        }
        "fill_missing" => {
            let col: String = serde_json::from_value(params.get("column").cloned().unwrap_or_default())
                .map_err(|e| e.to_string())?;
            let fill_type: String = serde_json::from_value(params.get("fill_type").cloned().unwrap_or_default())
                .map_err(|e| e.to_string())?;
            let custom_val: Option<String> = serde_json::from_value(params.get("custom_value").cloned().unwrap_or_default())
                .map_err(|e| e.to_string())?;
            engine.fill_missing_values(col, fill_type, custom_val, &target_path)?;
        }
        _ => return Err("Unknown cleaning operation".to_string()),
    }
    
    Ok(())
}

#[tauri::command]
async fn join_csv_files(
    state: State<'_, AppState>,
    file_id_a: String,
    key_col_a: String,
    file_id_b: String,
    key_col_b: String,
    join_type: String, // "inner" | "left" | "right" | "outer"
    target_path: String,
) -> Result<(), String> {
    let (engine_a, engine_b) = {
        let engines = state.engines.lock().unwrap();
        (engines.get(&file_id_a).cloned(), engines.get(&file_id_b).cloned())
    };

    let (engine_a, engine_b) = match (engine_a, engine_b) {
        (Some(a), Some(b)) => (a, b),
        _ => return Err("One or both sessions are not opened".to_string()),
    };

    let col_idx_a = engine_a.headers.iter().position(|h| h == &key_col_a)
        .ok_or_else(|| format!("Key column {} not found in file A", key_col_a))?;
    let col_idx_b = engine_b.headers.iter().position(|h| h == &key_col_b)
        .ok_or_else(|| format!("Key column {} not found in file B", key_col_b))?;

    // Load file B into memory (as right table index map)
    let mut right_table: HashMap<String, Vec<String>> = HashMap::new();
    let offsets_b = engine_b.row_offsets.read().unwrap();
    let mut file_b = File::open(&engine_b.path).map_err(|e| e.to_string())?;

    for &offset in offsets_b.iter() {
        file_b.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut rdr = csv::ReaderBuilder::new().has_headers(false).delimiter(engine_b.delimiter).from_reader(&mut file_b);
        let mut record = csv::ByteRecord::new();
        if rdr.read_byte_record(&mut record).unwrap_or(false) {
            let mut row = Vec::new();
            for field in record.iter() {
                let (decoded, _, _) = engine_b.encoding.decode(field);
                row.push(decoded.into_owned());
            }
            if let Some(key_val) = row.get(col_idx_b).cloned() {
                right_table.insert(key_val, row);
            }
        }
    }

    // Build joined headers
    // For headers overlapping, suffix them with _a and _b
    let mut joined_headers = Vec::new();
    for h in &engine_a.headers {
        joined_headers.push(h.clone());
    }
    for h in &engine_b.headers {
        if h != &key_col_b {
            joined_headers.push(format!("{}_b", h));
        }
    }

    let target_file = File::create(target_path).map_err(|e| e.to_string())?;
    let mut writer = csv::WriterBuilder::new()
        .delimiter(engine_a.delimiter)
        .from_writer(BufWriter::new(target_file));

    writer.write_record(&joined_headers).map_err(|e| e.to_string())?;

    let offsets_a = engine_a.row_offsets.read().unwrap();
    let mut file_a = File::open(&engine_a.path).map_err(|e| e.to_string())?;

    let mut matched_right_keys = std::collections::HashSet::new();

    // Stream through left table
    for &offset in offsets_a.iter() {
        file_a.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut rdr = csv::ReaderBuilder::new().has_headers(false).delimiter(engine_a.delimiter).from_reader(&mut file_a);
        let mut record = csv::ByteRecord::new();
        if rdr.read_byte_record(&mut record).unwrap_or(false) {
            let mut row_a = Vec::new();
            for field in record.iter() {
                let (decoded, _, _) = engine_a.encoding.decode(field);
                row_a.push(decoded.into_owned());
            }

            let key_val = row_a.get(col_idx_a).cloned().unwrap_or_default();
            let matched_b = right_table.get(&key_val);

            if matched_b.is_none() && (join_type == "inner" || join_type == "right") {
                continue; // skip
            }

            if matched_b.is_some() {
                matched_right_keys.insert(key_val.clone());
            }

            let mut joined_row = row_a.clone();
            if let Some(row_b) = matched_b {
                for (b_idx, val) in row_b.iter().enumerate() {
                    if b_idx != col_idx_b {
                        joined_row.push(val.clone());
                    }
                }
            } else {
                // Left Join empty padding
                for _ in 0..(engine_b.headers.len() - 1) {
                    joined_row.push("".to_string());
                }
            }

            writer.write_record(&joined_row).map_err(|e| e.to_string())?;
        }
    }

    // Outer / Right Join unmatched items from right table
    if join_type == "outer" || join_type == "right" {
        for (key_val, row_b) in &right_table {
            if !matched_right_keys.contains(key_val) {
                let mut joined_row = Vec::new();
                // Pad left table columns
                for h in &engine_a.headers {
                    if h == &key_col_a {
                        joined_row.push(key_val.clone());
                    } else {
                        joined_row.push("".to_string());
                    }
                }
                // Write right table columns
                for (b_idx, val) in row_b.iter().enumerate() {
                    if b_idx != col_idx_b {
                        joined_row.push(val.clone());
                    }
                }
                writer.write_record(&joined_row).map_err(|e| e.to_string())?;
            }
        }
    }

    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn split_csv_file(
    state: State<'_, AppState>,
    file_id: String,
    split_by: String, // "rows" | "column"
    row_limit: Option<usize>,
    column_name: Option<String>,
    output_dir: String,
) -> Result<Vec<String>, String> {
    let engine = {
        let engines = state.engines.lock().unwrap();
        engines.get(&file_id).cloned()
    };

    let engine = match engine {
        Some(e) => e,
        None => return Err("File not opened".to_string()),
    };

    let base_name = engine.path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let ext = engine.path.extension().unwrap_or_default().to_string_lossy().into_owned();
    let output_path = PathBuf::from(&output_dir);
    if !output_path.exists() {
        std::fs::create_dir_all(&output_path).map_err(|e| e.to_string())?;
    }

    let mut created_files = Vec::new();
    let offsets = engine.row_offsets.read().unwrap();
    let mut file = File::open(&engine.path).map_err(|e| e.to_string())?;

    if split_by == "rows" {
        let limit = row_limit.unwrap_or(50_000);
        let mut file_idx = 1;
        let mut row_count = 0;
        let mut writer: Option<csv::Writer<BufWriter<File>>> = None;

        for &offset in offsets.iter() {
            if writer.is_none() || row_count >= limit {
                if let Some(mut w) = writer.take() {
                    w.flush().map_err(|e| e.to_string())?;
                }
                let part_name = format!("{}_part_{}.{}", base_name, file_idx, ext);
                let target_file_path = output_path.join(&part_name);
                created_files.push(target_file_path.to_string_lossy().into_owned());
                
                let target_file = File::create(target_file_path).map_err(|e| e.to_string())?;
                let mut w = csv::WriterBuilder::new().delimiter(engine.delimiter).from_writer(BufWriter::new(target_file));
                w.write_record(&engine.headers).map_err(|e| e.to_string())?;
                
                writer = Some(w);
                row_count = 0;
                file_idx += 1;
            }

            file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            let mut rdr = csv::ReaderBuilder::new().has_headers(false).delimiter(engine.delimiter).from_reader(&mut file);
            let mut record = csv::ByteRecord::new();
            if rdr.read_byte_record(&mut record).unwrap_or(false) {
                let mut row = Vec::new();
                for field in record.iter() {
                    let (decoded, _, _) = engine.encoding.decode(field);
                    row.push(decoded.into_owned());
                }
                if let Some(ref mut w) = writer {
                    w.write_record(&row).map_err(|e| e.to_string())?;
                    row_count += 1;
                }
            }
        }

        if let Some(mut w) = writer {
            w.flush().map_err(|e| e.to_string())?;
        }
    } else if split_by == "column" {
        let col_name = column_name.ok_or_else(|| "Column name is required to split by column".to_string())?;
        let col_idx = engine.headers.iter().position(|h| h == &col_name)
            .ok_or_else(|| format!("Column {} not found", col_name))?;

        // Keep active writers in a hashmap to write as we stream
        let mut writers: HashMap<String, csv::Writer<BufWriter<File>>> = HashMap::new();

        for &offset in offsets.iter() {
            file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            let mut rdr = csv::ReaderBuilder::new().has_headers(false).delimiter(engine.delimiter).from_reader(&mut file);
            let mut record = csv::ByteRecord::new();
            if rdr.read_byte_record(&mut record).unwrap_or(false) {
                let mut row = Vec::new();
                for field in record.iter() {
                    let (decoded, _, _) = engine.encoding.decode(field);
                    row.push(decoded.into_owned());
                }

                // Sanitize column value to be safe filename
                let col_val = row.get(col_idx).cloned().unwrap_or_else(|| "unknown".to_string());
                let safe_val = col_val.chars()
                    .map(|c| if c.is_alphanumeric() { c } else { '_' })
                    .collect::<String>();
                let safe_val = if safe_val.trim().is_empty() { "empty".to_string() } else { safe_val };

                if !writers.contains_key(&safe_val) {
                    let part_name = format!("{}_{}.{}", base_name, safe_val, ext);
                    let target_file_path = output_path.join(&part_name);
                    created_files.push(target_file_path.to_string_lossy().into_owned());

                    let target_file = File::create(target_file_path).map_err(|e| e.to_string())?;
                    let mut w = csv::WriterBuilder::new().delimiter(engine.delimiter).from_writer(BufWriter::new(target_file));
                    w.write_record(&engine.headers).map_err(|e| e.to_string())?;
                    writers.insert(safe_val.clone(), w);
                }

                if let Some(w) = writers.get_mut(&safe_val) {
                    w.write_record(&row).map_err(|e| e.to_string())?;
                }
            }
        }

        // Flush all active writers
        for (_, mut w) in writers {
            w.flush().map_err(|e| e.to_string())?;
        }
    }

    Ok(created_files)
}

#[tauri::command]
async fn apply_csv_filter(
    state: State<'_, AppState>,
    file_id: String,
    rules: Vec<FilterRule>,
    conjunction: String,
) -> Result<usize, String> {
    let engine = {
        let engines = state.engines.lock().unwrap();
        engines.get(&file_id).cloned()
    };
    
    match engine {
        Some(e) => e.apply_filter(rules, conjunction),
        None => Err("File not opened or session expired".to_string()),
    }
}

#[tauri::command]
async fn clear_csv_filter(state: State<'_, AppState>, file_id: String) -> Result<(), String> {
    let engine = {
        let engines = state.engines.lock().unwrap();
        engines.get(&file_id).cloned()
    };
    
    match engine {
        Some(e) => {
            e.clear_filter();
            Ok(())
        }
        None => Err("File not opened or session expired".to_string()),
    }
}

#[tauri::command]
async fn sort_csv_column(
    state: State<'_, AppState>,
    file_id: String,
    column_name: String,
    descending: bool,
) -> Result<(), String> {
    let engine = {
        let engines = state.engines.lock().unwrap();
        engines.get(&file_id).cloned()
    };
    
    match engine {
        Some(e) => e.sort_column(&column_name, descending),
        None => Err("File not opened or session expired".to_string()),
    }
}

#[tauri::command]
async fn get_column_unique_values(
    state: State<'_, AppState>,
    file_id: String,
    column_name: String,
) -> Result<Vec<String>, String> {
    let engine = {
        let engines = state.engines.lock().unwrap();
        engines.get(&file_id).cloned()
    };
    
    match engine {
        Some(e) => e.get_column_unique_values(&column_name),
        None => Err("File not opened or session expired".to_string()),
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            engines: Arc::new(Mutex::new(HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            open_csv_file,
            get_csv_rows,
            update_csv_cell,
            get_csv_metadata,
            save_csv_file,
            apply_cleaning_op,
            join_csv_files,
            split_csv_file,
            apply_csv_filter,
            clear_csv_filter,
            sort_csv_column,
            get_column_unique_values
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
