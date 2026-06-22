use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicBool, AtomicUsize, AtomicU64, Ordering};
use serde::{Serialize, Deserialize};
use rayon::prelude::*;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ColumnSchema {
    pub name: String,
    pub data_type: String, // "String", "Numeric", "Boolean", "Datetime"
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CsvMetadata {
    pub file_id: String,
    pub path: String,
    pub delimiter: String,
    pub encoding: String,
    pub headers: Vec<String>,
    pub total_rows: usize,
    pub indexing_complete: bool,
    pub columns: Vec<ColumnSchema>,
    pub total_bytes: u64,
    pub indexed_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FilterRule {
    pub column: String,
    pub operator: String, // "contains" | "equals" | "starts_with" | "ends_with" | "is_empty" | "regex" | "eq" | "gt" | "lt"
    pub value: String,
}

pub struct CsvEngine {
    pub file_id: String,
    pub path: PathBuf,
    pub delimiter: u8,
    pub encoding: &'static encoding_rs::Encoding,
    pub headers: Vec<String>,
    pub first_record_offset: u64,
    pub row_offsets: Arc<RwLock<Vec<u64>>>,
    pub delta_state: Arc<RwLock<HashMap<usize, HashMap<String, String>>>>,
    pub total_rows: Arc<AtomicUsize>,
    pub indexing_complete: Arc<AtomicBool>,
    pub columns: Arc<RwLock<Vec<ColumnSchema>>>,
    pub total_bytes: u64,
    pub indexed_bytes: Arc<AtomicU64>,
    pub filtered_row_offsets: Arc<RwLock<Option<Vec<u64>>>>,
}

impl CsvEngine {
    pub fn new(file_id: String, path_str: &str) -> Result<Self, String> {
        let path = PathBuf::from(path_str);
        if !path.exists() {
            return Err(format!("File does not exist: {}", path_str));
        }

        // 1. Auto-detect delimiter and encoding
        let delimiter = detect_delimiter(&path);
        let encoding = detect_encoding(&path);

        // 2. Read headers and file metadata
        let file = File::open(&path).map_err(|e| e.to_string())?;
        let file_metadata = file.metadata().map_err(|e| e.to_string())?;
        let total_bytes = file_metadata.len();

        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(true)
            .delimiter(delimiter)
            .from_reader(file);

        let headers_raw = rdr.headers().map_err(|e| e.to_string())?;
        let mut headers = Vec::new();
        for field in headers_raw.iter() {
            let (decoded, _, _) = encoding.decode(field.as_bytes());
            headers.push(decoded.into_owned());
        }

        let first_record_offset = rdr.position().byte();

        let row_offsets = Arc::new(RwLock::new(Vec::new()));
        let total_rows = Arc::new(AtomicUsize::new(0));
        let indexing_complete = Arc::new(AtomicBool::new(false));
        let columns = Arc::new(RwLock::new(Vec::new()));
        let indexed_bytes = Arc::new(AtomicU64::new(0));
        let filtered_row_offsets = Arc::new(RwLock::new(None));

        let engine = Self {
            file_id,
            path,
            delimiter,
            encoding,
            headers,
            first_record_offset,
            row_offsets,
            delta_state: Arc::new(RwLock::new(HashMap::new())),
            total_rows,
            indexing_complete,
            columns,
            total_bytes,
            indexed_bytes,
            filtered_row_offsets,
        };

        // 3. Start background indexing and schema inference
        engine.start_indexing();

        Ok(engine)
    }

    fn start_indexing(&self) {
        let row_offsets = self.row_offsets.clone();
        let total_rows = self.total_rows.clone();
        let indexing_complete = self.indexing_complete.clone();
        let columns = self.columns.clone();
        let path = self.path.clone();
        let delimiter = self.delimiter;
        let encoding = self.encoding;
        let headers = self.headers.clone();
        let first_record_offset = self.first_record_offset;
        let total_bytes = self.total_bytes;
        let indexed_bytes = self.indexed_bytes.clone();

        std::thread::spawn(move || {
            // 1. Sample first 100 rows for schema inference
            let mut sample_rows = Vec::new();
            if let Ok(file_sample) = File::open(&path) {
                let mut rdr = csv::ReaderBuilder::new()
                    .has_headers(true)
                    .delimiter(delimiter)
                    .from_reader(file_sample);
                let mut record = csv::ByteRecord::new();
                while sample_rows.len() < 100 {
                    match rdr.read_byte_record(&mut record) {
                        Ok(true) => {
                            let mut row_fields = Vec::new();
                            for field in record.iter() {
                                let (decoded, _, _) = encoding.decode(field);
                                row_fields.push(decoded.into_owned());
                            }
                            sample_rows.push(row_fields);
                        }
                        _ => break,
                    }
                }
            }

            // Infer column types based on sample
            let mut inferred_cols = Vec::new();
            for (i, col_name) in headers.iter().enumerate() {
                let mut types_count = HashMap::new();
                for row in &sample_rows {
                    if let Some(val) = row.get(i) {
                        let t = infer_type(val);
                        if t != "Null" {
                            *types_count.entry(t).or_insert(0) += 1;
                        }
                    }
                }
                let data_type = if types_count.is_empty() {
                    "String".to_string()
                } else {
                    types_count.into_iter()
                        .max_by_key(|&(_, count)| count)
                        .map(|(t, _)| t.to_string())
                        .unwrap_or_else(|| "String".to_string())
                };
                inferred_cols.push(ColumnSchema {
                    name: col_name.clone(),
                    data_type,
                });
            }
            {
                let mut cols = columns.write().unwrap();
                *cols = inferred_cols;
            }

            // 2. Perform fast raw byte indexing
            let mut file = match File::open(&path) {
                Ok(f) => f,
                Err(_) => {
                    indexing_complete.store(true, Ordering::Relaxed);
                    return;
                }
            };
            if first_record_offset < total_bytes {
                if let Err(_) = file.seek(SeekFrom::Start(first_record_offset)) {
                    indexing_complete.store(true, Ordering::Relaxed);
                    return;
                }
            }
            let mut reader = std::io::BufReader::with_capacity(128 * 1024, file);
            let mut buffer = [0; 64 * 1024];
            let mut current_offset: u64 = first_record_offset;
            let mut in_quotes = false;
            let mut temp_offsets = Vec::with_capacity(100_000);

            if first_record_offset < total_bytes {
                temp_offsets.push(first_record_offset);
            }

            while let Ok(bytes_read) = reader.read(&mut buffer) {
                if bytes_read == 0 {
                    break;
                }
                for i in 0..bytes_read {
                    let b = buffer[i];
                    let offset = current_offset + i as u64;

                    if b == b'"' {
                        in_quotes = !in_quotes;
                    } else if b == b'\n' && !in_quotes {
                        // Subsequent rows start at byte after newline
                        temp_offsets.push(offset + 1);
                    }
                }
                current_offset += bytes_read as u64;
                indexed_bytes.store(current_offset, Ordering::Relaxed);

                if temp_offsets.len() >= 50_000 {
                    let mut offsets = row_offsets.write().unwrap();
                    offsets.extend(&temp_offsets);
                    total_rows.store(offsets.len(), Ordering::Relaxed);
                    temp_offsets.clear();
                }
            }

            if !temp_offsets.is_empty() {
                // If the last offset points beyond the end of the file, remove it
                if let Some(&last) = temp_offsets.last() {
                    if last >= current_offset {
                        temp_offsets.pop();
                    }
                }
                let mut offsets = row_offsets.write().unwrap();
                offsets.extend(&temp_offsets);
                total_rows.store(offsets.len(), Ordering::Relaxed);
            }

            indexed_bytes.store(total_bytes, Ordering::Relaxed);
            indexing_complete.store(true, Ordering::Relaxed);
        });
    }

    pub fn get_metadata(&self) -> CsvMetadata {
        let filtered_guard = self.filtered_row_offsets.read().unwrap();
        let total_rows = match &*filtered_guard {
            Some(v) => v.len(),
            None => self.total_rows.load(Ordering::Relaxed),
        };
        CsvMetadata {
            file_id: self.file_id.clone(),
            path: self.path.to_string_lossy().into_owned(),
            delimiter: (self.delimiter as char).to_string(),
            encoding: self.encoding.name().to_string(),
            headers: self.headers.clone(),
            total_rows,
            indexing_complete: self.indexing_complete.load(Ordering::Relaxed),
            columns: self.columns.read().unwrap().clone(),
            total_bytes: self.total_bytes,
            indexed_bytes: self.indexed_bytes.load(Ordering::Relaxed),
        }
    }

    pub fn get_rows(&self, offset: usize, limit: usize) -> Result<Vec<Vec<String>>, String> {
        let filtered_guard = self.filtered_row_offsets.read().unwrap();
        let offsets = match &*filtered_guard {
            Some(v) => v,
            None => &*self.row_offsets.read().unwrap(),
        };
        let total_indexed_rows = offsets.len();
        
        let delta = self.delta_state.read().unwrap();
        let max_delta_row = delta.keys().max().cloned().unwrap_or(0);
        let max_row = std::cmp::max(total_indexed_rows, if delta.is_empty() { 0 } else { max_delta_row + 1 });

        let mut rows = Vec::with_capacity(limit);

        for i in 0..limit {
            let current_row_idx = offset + i;
            if current_row_idx >= max_row {
                break;
            }

            if current_row_idx >= total_indexed_rows {
                // This is a newly added row not yet written to disk
                let mut row_data = Vec::with_capacity(self.headers.len());
                if let Some(row_edits) = delta.get(&current_row_idx) {
                    for col in &self.headers {
                        row_data.push(row_edits.get(col).cloned().unwrap_or_default());
                    }
                } else {
                    row_data = vec!["".to_string(); self.headers.len()];
                }
                rows.push(row_data);
                continue;
            }

            // Seek and read from physical file
            let start_byte = offsets[current_row_idx];
            let mut file = File::open(&self.path).map_err(|e| e.to_string())?;
            file.seek(SeekFrom::Start(start_byte)).map_err(|e| e.to_string())?;

            let mut rdr = csv::ReaderBuilder::new()
                .has_headers(false)
                .delimiter(self.delimiter)
                .from_reader(file);

            let mut record = csv::ByteRecord::new();
            if rdr.read_byte_record(&mut record).map_err(|e| e.to_string())? {
                let mut row_data = Vec::with_capacity(self.headers.len());
                for (col_idx, field_bytes) in record.iter().enumerate() {
                    let col_name = self.headers.get(col_idx).cloned().unwrap_or_else(|| col_idx.to_string());
                    
                    // Direct cell override
                    if let Some(cell_override) = delta.get(&current_row_idx).and_then(|r| r.get(&col_name)) {
                        row_data.push(cell_override.clone());
                    } else {
                        let (decoded, _, _) = self.encoding.decode(field_bytes);
                        row_data.push(decoded.into_owned());
                    }
                }
                // Handle case where CSV row has fewer fields than headers
                while row_data.len() < self.headers.len() {
                    let col_idx = row_data.len();
                    let col_name = &self.headers[col_idx];
                    if let Some(cell_override) = delta.get(&current_row_idx).and_then(|r| r.get(col_name)) {
                        row_data.push(cell_override.clone());
                    } else {
                        row_data.push("".to_string());
                    }
                }
                rows.push(row_data);
            } else {
                rows.push(vec!["".to_string(); self.headers.len()]);
            }
        }

        Ok(rows)
    }

    pub fn update_cell(&self, row_idx: usize, col_name: String, value: String) {
        let mut delta = self.delta_state.write().unwrap();
        delta.entry(row_idx).or_insert_with(HashMap::new).insert(col_name, value);
    }

    pub fn save_file(&self, target_path: &str) -> Result<(), String> {
        let mut file = File::open(&self.path).map_err(|e| e.to_string())?;
        let target_file = File::create(target_path).map_err(|e| e.to_string())?;
        let mut writer = csv::WriterBuilder::new()
            .delimiter(self.delimiter)
            .from_writer(BufWriter::new(target_file));

        // Write headers
        writer.write_record(&self.headers).map_err(|e| e.to_string())?;

        let offsets = self.row_offsets.read().unwrap();
        let total_indexed_rows = offsets.len();
        
        let delta = self.delta_state.read().unwrap();
        let max_delta_row = delta.keys().max().cloned().unwrap_or(0);
        let max_row = std::cmp::max(total_indexed_rows, if delta.is_empty() { 0 } else { max_delta_row + 1 });

        // Stream and overlay row by row to prevent memory usage spikes
        for current_row_idx in 0..max_row {
            let mut row_data = Vec::with_capacity(self.headers.len());

            if current_row_idx >= total_indexed_rows {
                if let Some(row_edits) = delta.get(&current_row_idx) {
                    for col in &self.headers {
                        row_data.push(row_edits.get(col).cloned().unwrap_or_default());
                    }
                } else {
                    row_data = vec!["".to_string(); self.headers.len()];
                }
            } else {
                let start_byte = offsets[current_row_idx];
                file.seek(SeekFrom::Start(start_byte)).map_err(|e| e.to_string())?;
                
                let mut rdr = csv::ReaderBuilder::new()
                    .has_headers(false)
                    .delimiter(self.delimiter)
                    .from_reader(&mut file);
                
                let mut record = csv::ByteRecord::new();
                if rdr.read_byte_record(&mut record).map_err(|e| e.to_string())? {
                    for (col_idx, field_bytes) in record.iter().enumerate() {
                        let col_name = self.headers.get(col_idx).cloned().unwrap_or_else(|| col_idx.to_string());
                        if let Some(cell_override) = delta.get(&current_row_idx).and_then(|r| r.get(&col_name)) {
                            row_data.push(cell_override.clone());
                        } else {
                            let (decoded, _, _) = self.encoding.decode(field_bytes);
                            row_data.push(decoded.into_owned());
                        }
                    }
                    while row_data.len() < self.headers.len() {
                        let col_name = &self.headers[row_data.len()];
                        if let Some(cell_override) = delta.get(&current_row_idx).and_then(|r| r.get(col_name)) {
                            row_data.push(cell_override.clone());
                        } else {
                            row_data.push("".to_string());
                        }
                    }
                } else {
                    row_data = vec!["".to_string(); self.headers.len()];
                }
            }

            writer.write_record(&row_data).map_err(|e| e.to_string())?;
        }

        writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    // 1-Click Deduplication
    pub fn deduplicate(&self, key_cols: Vec<String>, target_path: &str) -> Result<(), String> {
        let mut file = File::open(&self.path).map_err(|e| e.to_string())?;
        let target_file = File::create(target_path).map_err(|e| e.to_string())?;
        let mut writer = csv::WriterBuilder::new()
            .delimiter(self.delimiter)
            .from_writer(BufWriter::new(target_file));

        writer.write_record(&self.headers).map_err(|e| e.to_string())?;

        let offsets = self.row_offsets.read().unwrap();
        let total_indexed_rows = offsets.len();

        let delta = self.delta_state.read().unwrap();
        let max_delta_row = delta.keys().max().cloned().unwrap_or(0);
        let max_row = std::cmp::max(total_indexed_rows, if delta.is_empty() { 0 } else { max_delta_row + 1 });

        // Keep 64-bit FNV hashes of the keys to avoid high RAM use
        let mut seen_keys = HashSet::new();

        for current_row_idx in 0..max_row {
            let mut row_data = Vec::with_capacity(self.headers.len());
            if current_row_idx >= total_indexed_rows {
                if let Some(row_edits) = delta.get(&current_row_idx) {
                    for col in &self.headers {
                        row_data.push(row_edits.get(col).cloned().unwrap_or_default());
                    }
                } else {
                    row_data = vec!["".to_string(); self.headers.len()];
                }
            } else {
                let start_byte = offsets[current_row_idx];
                file.seek(SeekFrom::Start(start_byte)).map_err(|e| e.to_string())?;
                let mut rdr = csv::ReaderBuilder::new()
                    .has_headers(false)
                    .delimiter(self.delimiter)
                    .from_reader(&mut file);
                let mut record = csv::ByteRecord::new();
                if rdr.read_byte_record(&mut record).map_err(|e| e.to_string())? {
                    for (col_idx, field_bytes) in record.iter().enumerate() {
                        let col_name = self.headers.get(col_idx).cloned().unwrap_or_else(|| col_idx.to_string());
                        if let Some(cell_override) = delta.get(&current_row_idx).and_then(|r| r.get(&col_name)) {
                            row_data.push(cell_override.clone());
                        } else {
                            let (decoded, _, _) = self.encoding.decode(field_bytes);
                            row_data.push(decoded.into_owned());
                        }
                    }
                }
            }

            // Build key string and hash
            let mut key_builder = String::new();
            for key_col in &key_cols {
                if let Some(idx) = self.headers.iter().position(|h| h == key_col) {
                    if let Some(val) = row_data.get(idx) {
                        key_builder.push_str(val);
                        key_builder.push('|');
                    }
                }
            }

            let hash = fnv_hash(&key_builder);
            if seen_keys.insert(hash) {
                writer.write_record(&row_data).map_err(|e| e.to_string())?;
            }
        }

        writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    // Batch Strip Whitespace
    pub fn trim_whitespace(&self, target_cols: Vec<String>, target_path: &str) -> Result<(), String> {
        let mut file = File::open(&self.path).map_err(|e| e.to_string())?;
        let target_file = File::create(target_path).map_err(|e| e.to_string())?;
        let mut writer = csv::WriterBuilder::new()
            .delimiter(self.delimiter)
            .from_writer(BufWriter::new(target_file));

        writer.write_record(&self.headers).map_err(|e| e.to_string())?;

        let offsets = self.row_offsets.read().unwrap();
        let total_indexed_rows = offsets.len();
        let delta = self.delta_state.read().unwrap();
        let max_delta_row = delta.keys().max().cloned().unwrap_or(0);
        let max_row = std::cmp::max(total_indexed_rows, if delta.is_empty() { 0 } else { max_delta_row + 1 });

        for current_row_idx in 0..max_row {
            let mut row_data = Vec::with_capacity(self.headers.len());
            if current_row_idx >= total_indexed_rows {
                if let Some(row_edits) = delta.get(&current_row_idx) {
                    for col in &self.headers {
                        let val = row_edits.get(col).cloned().unwrap_or_default();
                        let is_target = target_cols.contains(col);
                        row_data.push(if is_target { val.trim().to_string() } else { val });
                    }
                }
            } else {
                let start_byte = offsets[current_row_idx];
                file.seek(SeekFrom::Start(start_byte)).map_err(|e| e.to_string())?;
                let mut rdr = csv::ReaderBuilder::new()
                    .has_headers(false)
                    .delimiter(self.delimiter)
                    .from_reader(&mut file);
                let mut record = csv::ByteRecord::new();
                if rdr.read_byte_record(&mut record).map_err(|e| e.to_string())? {
                    for (col_idx, field_bytes) in record.iter().enumerate() {
                        let col_name = self.headers.get(col_idx).cloned().unwrap_or_else(|| col_idx.to_string());
                        let val = if let Some(cell_override) = delta.get(&current_row_idx).and_then(|r| r.get(&col_name)) {
                            cell_override.clone()
                        } else {
                            let (decoded, _, _) = self.encoding.decode(field_bytes);
                            decoded.into_owned()
                        };
                        let is_target = target_cols.contains(&col_name);
                        row_data.push(if is_target { val.trim().to_string() } else { val });
                    }
                }
            }
            writer.write_record(&row_data).map_err(|e| e.to_string())?;
        }

        writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    // Missing Value Handler
    pub fn fill_missing_values(&self, col_name: String, fill_type: String, custom_val: Option<String>, target_path: &str) -> Result<(), String> {
        let col_idx = self.headers.iter().position(|h| h == &col_name)
            .ok_or_else(|| format!("Column {} not found", col_name))?;

        // 1. If Mean/Median/Mode is requested, compute it by scanning values
        let replacement_value = match fill_type.as_str() {
            "Value" => custom_val.unwrap_or_default(),
            "Mean" | "Median" => {
                let mut numbers = Vec::new();
                let offsets = self.row_offsets.read().unwrap();
                let mut file = File::open(&self.path).map_err(|e| e.to_string())?;
                for &offset in offsets.iter().take(10_000) { // sample max 10k rows for efficiency
                    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
                    let mut rdr = csv::ReaderBuilder::new().has_headers(false).delimiter(self.delimiter).from_reader(&mut file);
                    let mut record = csv::ByteRecord::new();
                    if rdr.read_byte_record(&mut record).unwrap_or(false) {
                        if let Some(field_bytes) = record.get(col_idx) {
                            let (decoded, _, _) = self.encoding.decode(field_bytes);
                            if let Ok(num) = decoded.trim().parse::<f64>() {
                                numbers.push(num);
                            }
                        }
                    }
                }

                if numbers.is_empty() {
                    "0".to_string()
                } else if fill_type == "Mean" {
                    let sum: f64 = numbers.iter().sum();
                    (sum / numbers.len() as f64).to_string()
                } else {
                    numbers.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    let mid = numbers.len() / 2;
                    if numbers.len() % 2 == 0 {
                        ((numbers[mid - 1] + numbers[mid]) / 2.0).to_string()
                    } else {
                        numbers[mid].to_string()
                    }
                }
            }
            "Mode" => {
                let mut freq_map = HashMap::new();
                let offsets = self.row_offsets.read().unwrap();
                let mut file = File::open(&self.path).map_err(|e| e.to_string())?;
                for &offset in offsets.iter().take(10_000) {
                    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
                    let mut rdr = csv::ReaderBuilder::new().has_headers(false).delimiter(self.delimiter).from_reader(&mut file);
                    let mut record = csv::ByteRecord::new();
                    if rdr.read_byte_record(&mut record).unwrap_or(false) {
                        if let Some(field_bytes) = record.get(col_idx) {
                            let (decoded, _, _) = self.encoding.decode(field_bytes);
                            let val = decoded.trim().to_string();
                            if !val.is_empty() {
                                *freq_map.entry(val).or_insert(0) += 1;
                            }
                        }
                    }
                }
                freq_map.into_iter()
                    .max_by_key(|&(_, count)| count)
                    .map(|(val, _)| val)
                    .unwrap_or_default()
            }
            _ => return Err("Invalid fill type".to_string()),
        };

        // 2. Stream and write with missing value filled or drop row
        let mut file = File::open(&self.path).map_err(|e| e.to_string())?;
        let target_file = File::create(target_path).map_err(|e| e.to_string())?;
        let mut writer = csv::WriterBuilder::new()
            .delimiter(self.delimiter)
            .from_writer(BufWriter::new(target_file));

        writer.write_record(&self.headers).map_err(|e| e.to_string())?;

        let offsets = self.row_offsets.read().unwrap();
        let total_indexed_rows = offsets.len();
        let delta = self.delta_state.read().unwrap();
        let max_delta_row = delta.keys().max().cloned().unwrap_or(0);
        let max_row = std::cmp::max(total_indexed_rows, if delta.is_empty() { 0 } else { max_delta_row + 1 });

        for current_row_idx in 0..max_row {
            let mut row_data = Vec::with_capacity(self.headers.len());
            if current_row_idx >= total_indexed_rows {
                if let Some(row_edits) = delta.get(&current_row_idx) {
                    for col in &self.headers {
                        row_data.push(row_edits.get(col).cloned().unwrap_or_default());
                    }
                }
            } else {
                let start_byte = offsets[current_row_idx];
                file.seek(SeekFrom::Start(start_byte)).map_err(|e| e.to_string())?;
                let mut rdr = csv::ReaderBuilder::new()
                    .has_headers(false)
                    .delimiter(self.delimiter)
                    .from_reader(&mut file);
                let mut record = csv::ByteRecord::new();
                if rdr.read_byte_record(&mut record).map_err(|e| e.to_string())? {
                    for (c_idx, field_bytes) in record.iter().enumerate() {
                        let col_name = self.headers.get(c_idx).cloned().unwrap_or_else(|| c_idx.to_string());
                        if let Some(cell_override) = delta.get(&current_row_idx).and_then(|r| r.get(&col_name)) {
                            row_data.push(cell_override.clone());
                        } else {
                            let (decoded, _, _) = self.encoding.decode(field_bytes);
                            row_data.push(decoded.into_owned());
                        }
                    }
                }
            }

            if let Some(val) = row_data.get_mut(col_idx) {
                if val.trim().is_empty() {
                    if fill_type == "Drop" {
                        continue; // drop row
                    } else {
                        *val = replacement_value.clone();
                    }
                }
            }
            writer.write_record(&row_data).map_err(|e| e.to_string())?;
        }

        writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn apply_filter(&self, rules: Vec<FilterRule>, conjunction: String) -> Result<usize, String> {
        let offsets = self.row_offsets.read().unwrap();
        let delta = self.delta_state.read().unwrap();

        let file = File::open(&self.path).map_err(|e| e.to_string())?;
        let mmap = unsafe { memmap2::Mmap::map(&file).map_err(|e| e.to_string())? };

        // Pre-compile and prepare rules
        let prepared_rules: Vec<PreparedRule> = rules.iter().filter_map(|rule| {
            let col_idx = self.headers.iter().position(|h| h == &rule.column)?;
            let value_lowercase = rule.value.to_lowercase();
            let regex = if rule.operator == "regex" {
                regex::Regex::new(&rule.value).ok()
            } else {
                None
            };
            let value_numeric = rule.value.trim().parse::<f64>().ok();
            let allowed_values = if rule.operator == "in" {
                if let Ok(vals) = serde_json::from_str::<Vec<String>>(&rule.value) {
                    Some(vals.into_iter().map(|v| v.to_lowercase()).collect::<HashSet<String>>())
                } else {
                    Some(rule.value.split(',').map(|v| v.trim().to_lowercase()).collect::<HashSet<String>>())
                }
            } else {
                None
            };
            Some(PreparedRule {
                col_idx,
                operator: rule.operator.clone(),
                value: rule.value.clone(),
                value_lowercase,
                regex,
                value_numeric,
                allowed_values,
            })
        }).collect();

        // Process all offsets in parallel using Rayon!
        let filtered: Vec<u64> = (0..offsets.len())
            .into_par_iter()
            .filter_map(|row_idx| {
                let start = offsets[row_idx] as usize;
                let end = if row_idx + 1 < offsets.len() {
                    offsets[row_idx + 1] as usize
                } else {
                    mmap.len()
                };
                let row_bytes = &mmap[start..end];

                let mut rdr = csv::ReaderBuilder::new()
                    .has_headers(false)
                    .delimiter(self.delimiter)
                    .from_reader(row_bytes);

                let mut record = csv::ByteRecord::new();
                if rdr.read_byte_record(&mut record).unwrap_or(false) {
                    let mut row_data = Vec::with_capacity(self.headers.len());
                    for (col_idx, field_bytes) in record.iter().enumerate() {
                        let col_name = self.headers.get(col_idx).cloned().unwrap_or_else(|| col_idx.to_string());
                        if let Some(cell_override) = delta.get(&row_idx).and_then(|r| r.get(&col_name)) {
                            row_data.push(cell_override.clone());
                        } else {
                            // Lazy Column Decoding: ONLY decode if this column is used in the rules!
                            let is_used_in_rules = rules.iter().any(|r| r.column == col_name);
                            if is_used_in_rules {
                                let (decoded, _, _) = self.encoding.decode(field_bytes);
                                row_data.push(decoded.into_owned());
                            } else {
                                row_data.push("".to_string());
                            }
                        }
                    }
                    while row_data.len() < self.headers.len() {
                        let col_idx = row_data.len();
                        let col_name = &self.headers[col_idx];
                        if let Some(cell_override) = delta.get(&row_idx).and_then(|r| r.get(col_name)) {
                            row_data.push(cell_override.clone());
                        } else {
                            row_data.push("".to_string());
                        }
                    }

                    if evaluate_prepared_row(&row_data, &prepared_rules, &conjunction) {
                        return Some(offsets[row_idx]);
                    }
                }
                None
            })
            .collect();

        let mut filtered_offsets = self.filtered_row_offsets.write().unwrap();
        let len = filtered.len();
        *filtered_offsets = Some(filtered);

        Ok(len)
    }

    pub fn clear_filter(&self) {
        let mut filtered_offsets = self.filtered_row_offsets.write().unwrap();
        *filtered_offsets = None;
    }

    pub fn sort_column(&self, col_name: &str, descending: bool) -> Result<(), String> {
        let col_idx = self.headers.iter().position(|h| h == col_name)
            .ok_or_else(|| format!("Column {} not found", col_name))?;

        let offsets = {
            let filtered_guard = self.filtered_row_offsets.read().unwrap();
            match &*filtered_guard {
                Some(v) => v.clone(),
                None => self.row_offsets.read().unwrap().clone(),
            }
        };

        if offsets.is_empty() {
            return Ok(());
        }

        let file = File::open(&self.path).map_err(|e| e.to_string())?;
        let mmap = unsafe { memmap2::Mmap::map(&file).map_err(|e| e.to_string())? };
        let delta = self.delta_state.read().unwrap();

        let mut row_values: Vec<(usize, String)> = (0..offsets.len())
            .into_par_iter()
            .map(|i| {
                let offset = offsets[i];
                let row_idx = match self.row_offsets.read().unwrap().binary_search(&offset) {
                    Ok(idx) => idx,
                    Err(_) => usize::MAX,
                };
                
                if row_idx != usize::MAX {
                    if let Some(cell_override) = delta.get(&row_idx).and_then(|r| r.get(col_name)) {
                        return (i, cell_override.clone());
                    }
                }

                let start = offset as usize;
                let end = {
                    let row_offsets_guard = self.row_offsets.read().unwrap();
                    let boundary = if row_idx != usize::MAX && row_idx + 1 < row_offsets_guard.len() {
                        row_offsets_guard[row_idx + 1] as usize
                    } else {
                        mmap.len()
                    };
                    if boundary < start { start } else { boundary }
                };

                let row_bytes = &mmap[start..end];
                if let Some(field_bytes) = parse_row_field(row_bytes, self.delimiter, col_idx) {
                    let (decoded, _, _) = self.encoding.decode(field_bytes);
                    return (i, decoded.into_owned());
                }
                (i, "".to_string())
            })
            .collect();

        let is_numeric = {
            let cols = self.columns.read().unwrap();
            cols.iter().find(|c| c.name == col_name)
                .map(|c| c.data_type == "Numeric")
                .unwrap_or(false)
        };

        row_values.sort_by(|(_, val_a), (_, val_b)| {
            if is_numeric {
                let num_a = val_a.trim().parse::<f64>().unwrap_or(f64::NAN);
                let num_b = val_b.trim().parse::<f64>().unwrap_or(f64::NAN);
                
                match (num_a.is_nan(), num_b.is_nan()) {
                    (true, true) => std::cmp::Ordering::Equal,
                    (true, false) => std::cmp::Ordering::Greater,
                    (false, true) => std::cmp::Ordering::Less,
                    (false, false) => {
                        let cmp = num_a.partial_cmp(&num_b).unwrap_or(std::cmp::Ordering::Equal);
                        if descending { cmp.reverse() } else { cmp }
                    }
                }
            } else {
                let cmp = val_a.to_lowercase().cmp(&val_b.to_lowercase());
                if descending { cmp.reverse() } else { cmp }
            }
        });

        let sorted_offsets: Vec<u64> = row_values.into_iter().map(|(idx, _)| offsets[idx]).collect();

        let mut filtered_offsets = self.filtered_row_offsets.write().unwrap();
        *filtered_offsets = Some(sorted_offsets);

        Ok(())
    }

    pub fn get_column_unique_values(&self, col_name: &str) -> Result<Vec<String>, String> {
        let col_idx = self.headers.iter().position(|h| h == col_name)
            .ok_or_else(|| format!("Column {} not found", col_name))?;

        let offsets = self.row_offsets.read().unwrap();
        let delta = self.delta_state.read().unwrap();

        let max_scan_rows = std::cmp::min(offsets.len(), 50_000);
        let mut row_idx_list: Vec<usize> = (0..max_scan_rows).collect();
        
        for &row_idx in delta.keys() {
            if row_idx >= offsets.len() && !row_idx_list.contains(&row_idx) {
                row_idx_list.push(row_idx);
            }
        }

        if row_idx_list.is_empty() {
            return Ok(Vec::new());
        }

        let file = File::open(&self.path).map_err(|e| e.to_string())?;
        let mmap = unsafe { memmap2::Mmap::map(&file).map_err(|e| e.to_string())? };

        let unique_vals: HashSet<String> = row_idx_list
            .into_par_iter()
            .map(|row_idx| {
                if let Some(cell_override) = delta.get(&row_idx).and_then(|r| r.get(col_name)) {
                    return cell_override.clone();
                }

                if row_idx >= offsets.len() {
                    return "".to_string();
                }

                let start = offsets[row_idx] as usize;
                let end = {
                    let boundary = if row_idx + 1 < offsets.len() {
                        offsets[row_idx + 1] as usize
                    } else {
                        mmap.len()
                    };
                    if boundary < start { start } else { boundary }
                };

                let row_bytes = &mmap[start..end];
                if let Some(field_bytes) = parse_row_field(row_bytes, self.delimiter, col_idx) {
                    let (decoded, _, _) = self.encoding.decode(field_bytes);
                    return decoded.trim().to_string();
                }
                "".to_string()
            })
            .collect();

        let mut sorted_vals: Vec<String> = unique_vals.into_iter().collect();
        
        let is_numeric = {
            let cols = self.columns.read().unwrap();
            cols.iter().find(|c| c.name == col_name)
                .map(|c| c.data_type == "Numeric")
                .unwrap_or(false)
        };

        sorted_vals.sort_by(|a, b| {
            if is_numeric {
                let num_a = a.parse::<f64>().unwrap_or(f64::NAN);
                let num_b = b.parse::<f64>().unwrap_or(f64::NAN);
                match (num_a.is_nan(), num_b.is_nan()) {
                    (true, true) => a.cmp(b),
                    (true, false) => std::cmp::Ordering::Greater,
                    (false, true) => std::cmp::Ordering::Less,
                    (false, false) => num_a.partial_cmp(&num_b).unwrap_or(std::cmp::Ordering::Equal),
                }
            } else {
                a.cmp(b)
            }
        });

        Ok(sorted_vals)
    }
}

fn parse_row_field(row_bytes: &[u8], delimiter: u8, col_idx: usize) -> Option<&[u8]> {
    let mut current_col = 0;
    let mut start = 0;
    let mut in_quotes = false;
    let mut i = 0;
    let len = row_bytes.len();

    while i < len {
        let b = row_bytes[i];
        if b == b'"' {
            in_quotes = !in_quotes;
        } else if b == delimiter && !in_quotes {
            if current_col == col_idx {
                let mut end = i;
                let mut s = start;
                if end > s && row_bytes[end - 1] == b'\r' {
                    end -= 1;
                }
                if end > s && row_bytes[s] == b'"' && row_bytes[end - 1] == b'"' {
                    s += 1;
                    end -= 1;
                }
                return Some(&row_bytes[s..end]);
            }
            current_col += 1;
            start = i + 1;
        }
        i += 1;
    }

    if current_col == col_idx {
        let mut end = len;
        let mut s = start;
        while end > s && (row_bytes[end - 1] == b'\n' || row_bytes[end - 1] == b'\r') {
            end -= 1;
        }
        if end > s && row_bytes[s] == b'"' && row_bytes[end - 1] == b'"' {
            s += 1;
            end -= 1;
        }
        return Some(&row_bytes[s..end]);
    }

    None
}

struct PreparedRule {
    col_idx: usize,
    operator: String,
    value: String,
    value_lowercase: String,
    regex: Option<regex::Regex>,
    value_numeric: Option<f64>,
    allowed_values: Option<HashSet<String>>,
}

fn evaluate_prepared_row(
    row: &[String],
    rules: &[PreparedRule],
    conjunction: &str,
) -> bool {
    if rules.is_empty() {
        return true;
    }

    let matches_rule = |rule: &PreparedRule| -> bool {
        let val = match row.get(rule.col_idx) {
            Some(v) => v,
            None => return false,
        };

        match rule.operator.as_str() {
            "equals" => val.eq_ignore_ascii_case(&rule.value),
            "contains" => val.to_lowercase().contains(&rule.value_lowercase),
            "starts_with" => val.to_lowercase().starts_with(&rule.value_lowercase),
            "ends_with" => val.to_lowercase().ends_with(&rule.value_lowercase),
            "is_empty" => val.trim().is_empty(),
            "regex" => {
                if let Some(ref re) = rule.regex {
                    re.is_match(val)
                } else {
                    false
                }
            }
            "eq" => {
                if let Some(rule_num) = rule.value_numeric {
                    if let Ok(n1) = val.trim().parse::<f64>() {
                        (n1 - rule_num).abs() < f64::EPSILON
                    } else {
                        false
                    }
                } else {
                    false
                }
            }
            "ne" | "neq" | "not_equals" | "!=" => {
                if let Some(rule_num) = rule.value_numeric {
                    if let Ok(n1) = val.trim().parse::<f64>() {
                        (n1 - rule_num).abs() >= f64::EPSILON
                    } else {
                        !val.eq_ignore_ascii_case(&rule.value)
                    }
                } else {
                    !val.eq_ignore_ascii_case(&rule.value)
                }
            }
            "gt" => {
                if let Some(rule_num) = rule.value_numeric {
                    if let Ok(n1) = val.trim().parse::<f64>() {
                        n1 > rule_num
                    } else {
                        false
                    }
                } else {
                    false
                }
            }
            "lt" => {
                if let Some(rule_num) = rule.value_numeric {
                    if let Ok(n1) = val.trim().parse::<f64>() {
                        n1 < rule_num
                    } else {
                        false
                    }
                } else {
                    false
                }
            }
            "in" => {
                if let Some(ref allowed) = rule.allowed_values {
                    allowed.contains(&val.to_lowercase())
                } else {
                    false
                }
            }
            _ => false,
        }
    };

    if conjunction == "OR" {
        rules.iter().any(matches_rule)
    } else {
        rules.iter().all(matches_rule)
    }
}

// 64-bit FNV-1a Hash for deduplication composite keys
fn fnv_hash(s: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325;
    for byte in s.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

// Heuristics to detect separator/delimiter
fn detect_delimiter(path: &Path) -> u8 {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return b',',
    };
    let mut buf = vec![0; 8192];
    let n = file.read(&mut buf).unwrap_or(0);
    if n == 0 {
        return b',';
    }
    
    let mut commas = 0;
    let mut semicolons = 0;
    let mut tabs = 0;
    let mut pipes = 0;
    
    let mut in_quotes = false;
    for &b in &buf[..n] {
        if b == b'"' {
            in_quotes = !in_quotes;
        }
        if !in_quotes {
            match b {
                b',' => commas += 1,
                b';' => semicolons += 1,
                b'\t' => tabs += 1,
                b'|' => pipes += 1,
                _ => {}
            }
        }
    }
    
    let max = *[commas, semicolons, tabs, pipes].iter().max().unwrap_or(&0);
    if max == 0 {
        b','
    } else if max == commas {
        b','
    } else if max == semicolons {
        b';'
    } else if max == tabs {
        b'\t'
    } else {
        b'|'
    }
}

// Decides Text Encoding
fn detect_encoding(path: &Path) -> &'static encoding_rs::Encoding {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return encoding_rs::UTF_8,
    };
    let mut buf = vec![0; 4096];
    let n = file.read(&mut buf).unwrap_or(0);
    if n >= 3 && &buf[..3] == [0xEF, 0xBB, 0xBF] {
        return encoding_rs::UTF_8;
    }
    if n >= 2 && &buf[..2] == [0xFF, 0xFE] {
        return encoding_rs::UTF_16LE;
    }
    if n >= 2 && &buf[..2] == [0xFE, 0xFF] {
        return encoding_rs::UTF_16BE;
    }
    if std::str::from_utf8(&buf[..n]).is_ok() {
        encoding_rs::UTF_8
    } else {
        encoding_rs::WINDOWS_1252
    }
}

// Infer data types per column values
fn infer_type(val: &str) -> &'static str {
    let val_trimmed = val.trim();
    if val_trimmed.is_empty() {
        return "Null";
    }
    if val_trimmed.eq_ignore_ascii_case("true") || val_trimmed.eq_ignore_ascii_case("false") {
        return "Boolean";
    }
    if val_trimmed.parse::<f64>().is_ok() {
        return "Numeric";
    }
    let has_date_dash = val_trimmed.chars().filter(|&c| c == '-').count() == 2;
    let has_date_slash = val_trimmed.chars().filter(|&c| c == '/').count() == 2;
    if (has_date_dash || has_date_slash) && val_trimmed.len() >= 8 {
        return "Datetime";
    }
    "String"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_indexing() {
        let content = "\n\nOA ID,Message ID,Type\n=\"42818482636130\",=\"a400d374807245\",=\"journey\"\n=\"second\",=\"row\",=\"here\"\n";
        let mut file = File::create("test_temp.csv").unwrap();
        file.write_all(content.as_bytes()).unwrap();

        let engine = CsvEngine::new("test_id".to_string(), "test_temp.csv").unwrap();
        // Wait for indexing to complete
        while !engine.indexing_complete.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        let offsets = engine.row_offsets.read().unwrap().clone();
        println!("TEST_OFFSETS: {:?}", offsets);

        let rows = engine.get_rows(0, 2).unwrap();
        println!("TEST_ROWS: {:?}", rows);

        std::fs::remove_file("test_temp.csv").unwrap();
        assert_eq!(rows[0][0], "=\"42818482636130\"");
    }
}
