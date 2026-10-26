The SILK v3 decoder implementation in `src/` is vendored from
`bizkernel/wxread`'s `crates/silk`, which identifies it as silk-decoder-rs 0.1.0
under the MIT License. Its upstream `LICENSE` is retained here. The small CLI
wrapper in `src/main.rs` reads bytes from stdin and writes mono 24 kHz PCM WAV
to stdout so decrypted voice data does not need a temporary file.
