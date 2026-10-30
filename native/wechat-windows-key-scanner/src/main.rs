use std::collections::HashSet;
use std::time::Duration;
#[cfg(windows)]
use std::time::Instant;

const MAX_PATTERN_BYTES: usize = 99;
const HEX_PATTERN_LEN: usize = 96;
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_MAX_CANDIDATES: usize = 4_096;

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
fn status(phase: &str, candidate_count: usize, regions_scanned: u64) {
    println!(
        "{{\"type\":\"status\",\"phase\":\"{phase}\",\"candidateCount\":{candidate_count},\"regionsScanned\":{regions_scanned}}}"
    );
}

fn emit_candidate(key: &str, salt: &str, candidate_count: usize) {
    println!(
        "{{\"type\":\"candidate\",\"key\":\"{key}\",\"salt\":\"{salt}\",\"candidateCount\":{candidate_count}}}"
    );
}

fn scan_key_patterns(
    buffer: &[u8],
    candidates: &mut HashSet<(String, String)>,
    max_candidates: usize,
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
        let inserted = candidates.insert((key.clone(), salt.clone()));
        if inserted {
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
    use windows::Win32::Foundation::CloseHandle;
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
        let pid = match options.pid {
            Some(value) => value,
            None => find_wechat_pid()?,
        };
        status("opening-process", 0, 0);
        let process = unsafe {
            OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid)
                .map_err(|error| format!("OpenProcess 失败，请以管理员身份运行 Rambo：{error}"))?
        };
        let result = scan_memory(process, &options);
        unsafe {
            let _ = CloseHandle(process);
        }
        result
    }

    fn find_wechat_pid() -> Result<u32, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
            .map_err(|error| format!("无法枚举 Windows 进程：{error}"))?;
        let mut entry = PROCESSENTRY32 {
            dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
            ..Default::default()
        };
        let mut found = None;
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
                    found = Some(entry.th32ProcessID);
                    break;
                }
                if Process32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
            let _ = CloseHandle(snapshot);
        }
        found.ok_or_else(|| {
            "找不到 Weixin.exe 进程，请确认 Windows 微信已登录并保持运行".to_string()
        })
    }

    fn scan_memory(
        process: windows::Win32::Foundation::HANDLE,
        options: &Options,
    ) -> Result<(), String> {
        let started = Instant::now();
        let mut address = 0usize;
        let mut candidates = HashSet::new();
        let mut regions_scanned = 0u64;
        let mut scanned_bytes = 0u64;
        status("scanning", 0, 0);
        loop {
            if started.elapsed() >= options.timeout {
                status("timeout", candidates.len(), regions_scanned);
                return Ok(());
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
                regions_scanned += 1;
                if scan_region(
                    process,
                    base,
                    size,
                    &mut candidates,
                    options.max_candidates,
                    started,
                    options.timeout,
                )? {
                    status(
                        if started.elapsed() >= options.timeout {
                            "timeout"
                        } else {
                            "complete"
                        },
                        candidates.len(),
                        regions_scanned,
                    );
                    return Ok(());
                }
                scanned_bytes = scanned_bytes.saturating_add(size as u64);
                if regions_scanned % 64 == 0 {
                    status("scanning", candidates.len(), regions_scanned);
                }
            }
            let next = base.saturating_add(size);
            if next == 0 || next <= address {
                break;
            }
            address = next;
        }
        let _ = scanned_bytes;
        status("complete", candidates.len(), regions_scanned);
        Ok(())
    }

    fn scan_region(
        process: windows::Win32::Foundation::HANDLE,
        base: usize,
        size: usize,
        candidates: &mut HashSet<(String, String)>,
        max_candidates: usize,
        started: Instant,
        timeout: Duration,
    ) -> Result<bool, String> {
        let mut offset = 0usize;
        while offset < size {
            if started.elapsed() >= timeout {
                return Ok(true);
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
                if scan_key_patterns(&buffer, candidates, max_candidates) {
                    return Ok(true);
                }
            }
            offset += if chunk_size > MAX_PATTERN_BYTES {
                chunk_size - MAX_PATTERN_BYTES
            } else {
                chunk_size
            };
        }
        Ok(false)
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

    #[test]
    fn finds_adjacent_key_and_salt_pattern() {
        let key = "ab".repeat(32);
        let salt = "cd".repeat(16);
        let input = format!("prefix x'{key}{salt}' suffix");
        let mut candidates = HashSet::new();
        assert!(!scan_key_patterns(input.as_bytes(), &mut candidates, 10));
        assert_eq!(candidates.len(), 1);
        assert!(candidates.contains(&(key, salt)));
    }

    #[test]
    fn rejects_invalid_or_short_patterns() {
        let mut candidates = HashSet::new();
        assert!(!scan_key_patterns(b"x'deadbeef'", &mut candidates, 10));
        assert!(candidates.is_empty());
    }

    #[test]
    fn stops_at_candidate_limit() {
        let key = "01".repeat(32);
        let salt = "02".repeat(16);
        let input = format!("x'{key}{salt}'");
        let mut candidates = HashSet::new();
        assert!(scan_key_patterns(input.as_bytes(), &mut candidates, 1));
    }
}
