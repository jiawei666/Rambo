use std::collections::HashSet;
use std::time::Duration;
#[cfg(windows)]
use std::time::Instant;

const MAX_PATTERN_BYTES: usize = 99;
const HEX_PATTERN_LEN: usize = 96;
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_MAX_CANDIDATES: usize = 4_096;

/// WeChat 4.1 keeps the `x'<64-hex key><32-hex salt>'` literal in a
/// `Config.Cipher` blob that is XOR-obfuscated with this fixed mask. The mask
/// is aligned to the literal itself, so decoding works wherever the blob sits.
const XOR_MASK: [u8; 32] = [
    0xd2, 0xc7, 0x44, 0x24, 0x58, 0x02, 0x00, 0x00, 0x00, 0x48, 0x89, 0x44, 0x24, 0x50, 0x48, 0x8b,
    0x45, 0x00, 0x48, 0x84, 0x4c, 0x24, 0x48, 0x48, 0x89, 0x44, 0x25, 0x40, 0x48, 0x58, 0x4c, 0x24,
];
const MASKED_LEAD: u8 = b'x' ^ XOR_MASK[0];
const MASKED_QUOTE: u8 = b'\'' ^ XOR_MASK[1];
const MASKED_END_INDEX: usize = HEX_PATTERN_LEN + 2;

/// Candidate counters per extraction strategy, reported so a future WeChat
/// build that changes its memory layout is diagnosable without key material.
#[derive(Default, Clone, Copy)]
struct ScanCounts {
    plaintext: usize,
    masked: usize,
}

#[cfg_attr(not(windows), allow(dead_code))]
struct Options {
    pid: Option<u32>,
    timeout: Duration,
    max_candidates: usize,
}

fn main() {
    let options = match parse_options(std::env::args().skip(1)) {
        Ok(value) => value,
        Err(message) => exit_with_error(&message, 2),
    };
    #[cfg(not(windows))]
    {
        let _ = options;
        exit_with_error("Windows 微信密钥扫描器只能在 Windows 上运行", 2);
    }
    #[cfg(windows)]
    {
        if let Err(message) = windows_scan::run(options) {
            exit_with_error(&message, 3);
        }
    }
}

fn parse_options(args: impl Iterator<Item = String>) -> Result<Options, String> {
    let mut pid = None;
    let mut timeout_ms = DEFAULT_TIMEOUT_MS;
    let mut max_candidates = DEFAULT_MAX_CANDIDATES;
    let values: Vec<String> = args.collect();
    let mut index = 0;
    while index < values.len() {
        let argument = &values[index];
        let value = values
            .get(index + 1)
            .ok_or_else(|| format!("参数 {argument} 缺少取值"))?;
        match argument.as_str() {
            "--pid" => {
                pid = Some(
                    value
                        .parse::<u32>()
                        .map_err(|_| "--pid 必须是正整数".to_string())?,
                );
            }
            "--timeout-ms" => {
                timeout_ms = value
                    .parse::<u64>()
                    .map_err(|_| "--timeout-ms 必须是正整数".to_string())?
                    .clamp(1_000, 300_000);
            }
            "--max-candidates" => {
                max_candidates = value
                    .parse::<usize>()
                    .map_err(|_| "--max-candidates 必须是正整数".to_string())?
                    .clamp(1, 16_384);
            }
            _ => return Err(format!("不支持的参数：{argument}")),
        }
        index += 2;
    }
    Ok(Options {
        pid,
        timeout: Duration::from_millis(timeout_ms),
        max_candidates,
    })
}

fn exit_with_error(message: &str, code: i32) -> ! {
    eprintln!("{message}");
    std::process::exit(code)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn status(phase: &str, candidate_count: usize, regions_scanned: u64, counts: &ScanCounts) {
    println!(
        "{{\"type\":\"status\",\"phase\":\"{phase}\",\"candidateCount\":{candidate_count},\"regionsScanned\":{regions_scanned},\"plaintextCount\":{},\"maskedCount\":{}}}",
        counts.plaintext, counts.masked
    );
}

fn emit_candidate(key: &str, salt: &str, candidate_count: usize) {
    println!(
        "{{\"type\":\"candidate\",\"key\":\"{key}\",\"salt\":\"{salt}\",\"candidateCount\":{candidate_count}}}"
    );
}

/// Finds the legacy plaintext `x'<64-hex key><32-hex salt>'` literal that
/// WeChat 4.0.x caches directly on its heap.
fn scan_key_patterns(
    buffer: &[u8],
    candidates: &mut HashSet<(String, String)>,
    max_candidates: usize,
    counts: &mut ScanCounts,
) -> bool {
    if buffer.len() < MAX_PATTERN_BYTES {
        return false;
    }
    let mut index = 0;
    while index + MAX_PATTERN_BYTES <= buffer.len() {
        if buffer[index] != b'x' || buffer[index + 1] != b'\'' {
            index += 1;
            continue;
        }
        let hex_start = index + 2;
        let hex = &buffer[hex_start..hex_start + HEX_PATTERN_LEN];
        if !hex.iter().all(u8::is_ascii_hexdigit) || buffer[hex_start + HEX_PATTERN_LEN] != b'\'' {
            index += 1;
            continue;
        }
        let key = String::from_utf8_lossy(&hex[..64]).to_lowercase();
        let salt = String::from_utf8_lossy(&hex[64..]).to_lowercase();
        if candidates.insert((key.clone(), salt.clone())) {
            counts.plaintext += 1;
            emit_candidate(&key, &salt, candidates.len());
            if candidates.len() >= max_candidates {
                return true;
            }
        }
        index += MAX_PATTERN_BYTES;
    }
    false
}

/// Finds the same literal when WeChat 4.1 stores it XOR-obfuscated inside its
/// `Config.Cipher` blob. No object offsets are assumed: the mask is aligned to
/// the literal, so this survives heap-layout and version changes.
fn scan_masked_patterns(
    buffer: &[u8],
    candidates: &mut HashSet<(String, String)>,
    max_candidates: usize,
    counts: &mut ScanCounts,
) -> bool {
    if buffer.len() < MAX_PATTERN_BYTES {
        return false;
    }
    let mut index = 0;
    while index + MAX_PATTERN_BYTES <= buffer.len() {
        if buffer[index] != MASKED_LEAD || buffer[index + 1] != MASKED_QUOTE {
            index += 1;
            continue;
        }
        let mut decoded = [0u8; HEX_PATTERN_LEN];
        let mut valid = true;
        for offset in 0..HEX_PATTERN_LEN {
            let value = buffer[index + 2 + offset] ^ XOR_MASK[(2 + offset) % XOR_MASK.len()];
            if !value.is_ascii_hexdigit() {
                valid = false;
                break;
            }
            decoded[offset] = value;
        }
        if !valid
            || buffer[index + MASKED_END_INDEX] ^ XOR_MASK[MASKED_END_INDEX % XOR_MASK.len()]
                != b'\''
        {
            index += 1;
            continue;
        }
        let key = String::from_utf8_lossy(&decoded[..64]).to_lowercase();
        let salt = String::from_utf8_lossy(&decoded[64..]).to_lowercase();
        if candidates.insert((key.clone(), salt.clone())) {
            counts.masked += 1;
            emit_candidate(&key, &salt, candidates.len());
            if candidates.len() >= max_candidates {
                return true;
            }
        }
        index += MAX_PATTERN_BYTES;
    }
    false
}

#[cfg(windows)]
mod windows_scan {
    use super::*;
    use std::ffi::{c_void, CStr};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Memory::{
        VirtualQueryEx, MEMORY_BASIC_INFORMATION, MEM_COMMIT, PAGE_EXECUTE_READWRITE,
        PAGE_EXECUTE_WRITECOPY, PAGE_GUARD, PAGE_NOCACHE, PAGE_READWRITE, PAGE_WRITECOMBINE,
        PAGE_WRITECOPY,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    const CHUNK_SIZE: usize = 2 * 1024 * 1024;

    pub(super) fn run(options: Options) -> Result<(), String> {
        let pids = match options.pid {
            Some(value) => vec![value],
            None => find_wechat_pids()?,
        };
        let started = Instant::now();
        let mut candidates = HashSet::new();
        let mut counts = ScanCounts::default();
        let mut regions_scanned = 0u64;
        let mut open_error: Option<String> = None;
        let mut timed_out = false;
        status("scanning", 0, 0, &counts);
        for pid in pids {
            if started.elapsed() >= options.timeout {
                timed_out = true;
                break;
            }
            let process = match unsafe {
                OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid)
            } {
                Ok(handle) => handle,
                Err(error) => {
                    if open_error.is_none() {
                        open_error =
                            Some(format!("OpenProcess 失败，请以管理员身份运行 Rambo：{error}"));
                    }
                    continue;
                }
            };
            let stopped = scan_process(
                process,
                &options,
                started,
                &mut candidates,
                &mut counts,
                &mut regions_scanned,
            );
            unsafe {
                let _ = CloseHandle(process);
            }
            if started.elapsed() >= options.timeout {
                timed_out = true;
            }
            if stopped || !candidates.is_empty() || timed_out {
                break;
            }
        }
        if candidates.is_empty() && regions_scanned == 0 {
            if let Some(error) = open_error {
                return Err(error);
            }
        }
        status(
            if timed_out { "timeout" } else { "complete" },
            candidates.len(),
            regions_scanned,
            &counts,
        );
        Ok(())
    }

    /// Every WeChat build runs several `Weixin.exe` processes. The account key
    /// lives in the root process, so roots are tried before their children and
    /// the remaining processes are only scanned when nothing was found.
    fn find_wechat_pids() -> Result<Vec<u32>, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
            .map_err(|error| format!("无法枚举 Windows 进程：{error}"))?;
        let mut entry = PROCESSENTRY32 {
            dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
            ..Default::default()
        };
        let mut entries: Vec<(u32, u32)> = Vec::new();
        unsafe {
            if Process32First(snapshot, &mut entry).is_err() {
                let _ = CloseHandle(snapshot);
                return Err("无法读取 Windows 进程列表".to_string());
            }
            loop {
                let name = CStr::from_ptr(entry.szExeFile.as_ptr()).to_string_lossy();
                if name.eq_ignore_ascii_case("Weixin.exe")
                    || name.eq_ignore_ascii_case("WeChat.exe")
                {
                    entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
                }
                if Process32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
            let _ = CloseHandle(snapshot);
        }
        if entries.is_empty() {
            return Err("找不到 Weixin.exe 进程，请确认 Windows 微信已登录并保持运行".to_string());
        }
        let known: HashSet<u32> = entries.iter().map(|(pid, _)| *pid).collect();
        let mut ordered: Vec<u32> = Vec::with_capacity(entries.len());
        for (pid, parent) in &entries {
            if !known.contains(parent) {
                ordered.push(*pid);
            }
        }
        for (pid, _) in &entries {
            if !ordered.contains(pid) {
                ordered.push(*pid);
            }
        }
        Ok(ordered)
    }

    fn scan_process(
        process: HANDLE,
        options: &Options,
        started: Instant,
        candidates: &mut HashSet<(String, String)>,
        counts: &mut ScanCounts,
        regions_scanned: &mut u64,
    ) -> bool {
        let mut address = 0usize;
        loop {
            if started.elapsed() >= options.timeout {
                return true;
            }
            let mut information = MEMORY_BASIC_INFORMATION::default();
            let queried = unsafe {
                VirtualQueryEx(
                    process,
                    Some(address as *const c_void),
                    &mut information,
                    std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
                )
            };
            if queried == 0 {
                break;
            }
            let base = information.BaseAddress as usize;
            let size = information.RegionSize;
            if information.State == MEM_COMMIT && is_writable_readable_page(information.Protect.0) {
                *regions_scanned += 1;
                if scan_region(
                    process,
                    base,
                    size,
                    candidates,
                    options.max_candidates,
                    counts,
                    started,
                    options.timeout,
                ) {
                    return true;
                }
                if *regions_scanned % 64 == 0 {
                    status("scanning", candidates.len(), *regions_scanned, counts);
                }
            }
            let next = base.saturating_add(size);
            if next == 0 || next <= address {
                break;
            }
            address = next;
        }
        false
    }

    #[allow(clippy::too_many_arguments)]
    fn scan_region(
        process: HANDLE,
        base: usize,
        size: usize,
        candidates: &mut HashSet<(String, String)>,
        max_candidates: usize,
        counts: &mut ScanCounts,
        started: Instant,
        timeout: Duration,
    ) -> bool {
        let mut offset = 0usize;
        while offset < size {
            if started.elapsed() >= timeout {
                return true;
            }
            let chunk_size = CHUNK_SIZE.min(size - offset);
            let mut buffer = vec![0u8; chunk_size];
            let mut bytes_read = 0usize;
            let read = unsafe {
                ReadProcessMemory(
                    process,
                    (base + offset) as *const c_void,
                    buffer.as_mut_ptr() as *mut c_void,
                    chunk_size,
                    Some(&mut bytes_read),
                )
            };
            if read.is_ok() && bytes_read > 0 {
                buffer.truncate(bytes_read);
                if scan_key_patterns(&buffer, candidates, max_candidates, counts) {
                    return true;
                }
                if scan_masked_patterns(&buffer, candidates, max_candidates, counts) {
                    return true;
                }
            }
            offset += if chunk_size > MAX_PATTERN_BYTES {
                chunk_size - MAX_PATTERN_BYTES
            } else {
                chunk_size
            };
        }
        false
    }

    fn is_writable_readable_page(protect: u32) -> bool {
        let base = protect & !(PAGE_GUARD.0 | PAGE_NOCACHE.0 | PAGE_WRITECOMBINE.0);
        matches!(
            base,
            value if value == PAGE_READWRITE.0
                || value == PAGE_WRITECOPY.0
                || value == PAGE_EXECUTE_READWRITE.0
                || value == PAGE_EXECUTE_WRITECOPY.0
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask_literal(value: &str) -> Vec<u8> {
        let plain = format!("x'{value}'");
        plain
            .bytes()
            .enumerate()
            .map(|(index, byte)| byte ^ XOR_MASK[index % XOR_MASK.len()])
            .collect()
    }

    #[test]
    fn finds_adjacent_key_and_salt_pattern() {
        let key = "ab".repeat(32);
        let salt = "cd".repeat(16);
        let input = format!("prefix x'{key}{salt}' suffix");
        let mut candidates = HashSet::new();
        let mut counts = ScanCounts::default();
        assert!(!scan_key_patterns(
            input.as_bytes(),
            &mut candidates,
            10,
            &mut counts
        ));
        assert_eq!(candidates.len(), 1);
        assert!(candidates.contains(&(key, salt)));
        assert_eq!(counts.plaintext, 1);
        assert_eq!(counts.masked, 0);
    }

    #[test]
    fn finds_xor_masked_key_and_salt_pattern() {
        let key = "3f".repeat(32);
        let salt = "91".repeat(16);
        let mut input = b"heap-noise".to_vec();
        input.extend(mask_literal(&format!("{key}{salt}")));
        input.extend(b"tail");
        let mut candidates = HashSet::new();
        let mut counts = ScanCounts::default();
        assert!(!scan_masked_patterns(
            &input,
            &mut candidates,
            10,
            &mut counts
        ));
        assert_eq!(candidates.len(), 1);
        assert!(candidates.contains(&(key, salt)));
        assert_eq!(counts.masked, 1);
        assert_eq!(counts.plaintext, 0);
    }

    #[test]
    fn masked_scan_ignores_wrong_mask_and_non_hex_blobs() {
        let key = "aa".repeat(32);
        let salt = "bb".repeat(16);
        let masked = mask_literal(&format!("{key}{salt}"));
        let mut candidates = HashSet::new();
        let mut counts = ScanCounts::default();

        // A non-hex byte in the middle of an otherwise masked literal.
        let mut corrupted = masked.clone();
        let corrupt_index = 2 + 40;
        corrupted[corrupt_index] = b'g' ^ XOR_MASK[corrupt_index % XOR_MASK.len()];
        assert!(!scan_masked_patterns(
            &corrupted,
            &mut candidates,
            10,
            &mut counts
        ));
        assert!(candidates.is_empty());

        // A blob encoded with a different mask phase must not decode.
        let mut other_phase: Vec<u8> = format!("x'{key}{salt}'")
            .bytes()
            .enumerate()
            .map(|(index, byte)| byte ^ XOR_MASK[(index + 1) % XOR_MASK.len()])
            .collect();
        other_phase.insert(0, 0);
        assert!(!scan_masked_patterns(
            &other_phase,
            &mut candidates,
            10,
            &mut counts
        ));
        assert!(candidates.is_empty());
        assert_eq!(counts.masked, 0);
    }

    #[test]
    fn rejects_invalid_or_short_patterns() {
        let mut candidates = HashSet::new();
        let mut counts = ScanCounts::default();
        assert!(!scan_key_patterns(
            b"x'deadbeef'",
            &mut candidates,
            10,
            &mut counts
        ));
        assert!(!scan_masked_patterns(
            b"x'deadbeef'",
            &mut candidates,
            10,
            &mut counts
        ));
        assert!(candidates.is_empty());
    }

    #[test]
    fn stops_at_candidate_limit() {
        let key = "01".repeat(32);
        let salt = "02".repeat(16);
        let input = format!("x'{key}{salt}'");
        let mut candidates = HashSet::new();
        let mut counts = ScanCounts::default();
        assert!(scan_key_patterns(
            input.as_bytes(),
            &mut candidates,
            1,
            &mut counts
        ));
    }

    #[test]
    fn masked_scan_stops_at_candidate_limit() {
        let key = "0a".repeat(32);
        let salt = "0b".repeat(16);
        let input = mask_literal(&format!("{key}{salt}"));
        let mut candidates = HashSet::new();
        let mut counts = ScanCounts::default();
        assert!(scan_masked_patterns(
            &input,
            &mut candidates,
            1,
            &mut counts
        ));
        assert_eq!(counts.masked, 1);
    }
}
