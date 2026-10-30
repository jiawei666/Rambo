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
