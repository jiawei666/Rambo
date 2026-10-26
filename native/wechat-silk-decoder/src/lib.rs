//! A SILK v3 decoder in safe Rust: WeChat's voice codec, decoded from
//! bytes to mono 16-bit PCM ([`decode`]), so `wxread voice` writes a voice
//! message as a file that plays with no other tool
//! (docs/adr/0007-voice-is-decoded-in-process.md).
//!
//! The decoder is silk-decoder-rs 0.1.0 (MIT, `LICENSE`), a port of the
//! SILK SDK's reference decoder, vendored as bizkernel vendored it: as it
//! was but for its one entry point, which read a path and answered a WAV,
//! where [`decode`] takes the bytes and answers the samples, so no
//! decrypted byte is written to disk to be read back. Its tests hold it to
//! the reference C decoder's output, sample for sample.

#![forbid(unsafe_code)]
// Vendored as it was: its own idiom, not this workspace's lints.
#![allow(clippy::all)]

mod biquad;
mod cng;
mod decode_core;
mod decode_parameters;
mod decoder;
mod fixed;
mod gains;
mod math;
mod nlsf;
mod nlsf2a;
mod pitch;
mod plc;
mod pulses_codec;
mod range_coder;
mod resampler;
mod resampler_tables;
mod sdk_api;
mod shell_coder;
mod tables_control;
mod tables_ltp;
mod tables_nlsf;
mod tables_nlsf_vec;
mod tables_pitch_lag;
mod tables_pulses;

pub use sdk_api::SilkError;
pub use sdk_api::decode;
