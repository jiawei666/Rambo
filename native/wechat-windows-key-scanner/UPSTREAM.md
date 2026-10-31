# Windows key scanner provenance

The Windows process-memory scan in this directory is adapted from
`jackwener/wx-cli-again` (also published as `botiverse/wx-cli`), version
`0.6.3`, at commit:

`077a54cbfe679bda963cd038d8440422907fc797`

Source files used:

- `src/scanner/windows.rs`
- `src/scanner/mod.rs`
- `src/config.rs`

Upstream license: Apache-2.0. A copy is kept in `LICENSE`.

Local changes:

- Reduced the helper to a Windows-only candidate-key scanner.
- Added JSON-lines status output, bounded candidate count, scan timeout, and
  progress reporting.
- Kept database matching and SQLCipher HMAC verification in Rambo's TypeScript
  process so candidate keys are validated against the selected account.
- Scans every `Weixin.exe` process (root process first) instead of only the
  first match, and reports per-strategy candidate counts.

## Config.Cipher obfuscation

WeChat 4.1 no longer keeps the `x'<64-hex key><32-hex salt>'` literal as
plaintext on the heap. It lives inside the `com.Tencent.WCDB.Config.Cipher`
object and is XOR-obfuscated with a fixed 32-byte mask. That mask and the
object-discovery technique were published under the MIT license by:

- `TANGandXUE/wcdb-key-tool` (`wcdb_key_tool_windows.py`)
- `9-dream-come-true-9/wechat-local-reader` (`scripts/微信本地记录读取器.py`),
  which adapts the former.

Rambo reuses only the mask constant and the "masked literal" idea. It does not
copy their object-offset walk: the scanner decodes any literal whose XOR mask
aligns with the literal itself, so it does not depend on heap offsets that
change between WeChat builds.
