use crate::biquad::biquad;
use crate::cng::cng;
use crate::decode_core::decode_core;
use crate::decode_parameters::decode_parameters;
use crate::decoder::{DecoderControl, DecoderState, NB_SUBFR};
use crate::plc::{plc, plc_glue_frames};
use crate::range_coder::{MAX_ARITHM_BYTES, RANGE_CODER_DEC_PAYLOAD_TOO_LONG};
use crate::resampler::SimpleResampler;

const DEC_INVALID_SAMPLING_FREQUENCY: i32 = -10;
const DEC_PAYLOAD_TOO_LARGE: i32 = -11;
const DEC_PAYLOAD_ERROR: i32 = -12;

#[derive(Clone, Copy, Debug, Default)]
struct DecControl {
    api_sample_rate: i32,
    frame_size: i32,
    frames_per_packet: i32,
    more_internal_decoder_frames: i32,
    in_band_fec_offset: i32,
}

const MORE_FRAMES: i32 = 1;
const LAST_FRAME: i32 = 0;
const LBRR_VER1: i32 = 2;
const LBRR_VER2: i32 = 3;
const NO_LBRR_THRES: i32 = 10;

#[derive(Default)]
pub struct SilkDecoder {
    pub state: DecoderState,
    resampler: Option<SimpleResampler>,
    resampler_in_hz: u32,
    resampler_out_hz: u32,
}

impl SilkDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    fn map_rc_error(err: i32) -> i32 {
        if err == RANGE_CODER_DEC_PAYLOAD_TOO_LONG {
            DEC_PAYLOAD_TOO_LARGE
        } else {
            DEC_PAYLOAD_ERROR
        }
    }

    fn on_payload_error(
        &mut self,
        action: &mut i32,
        used_bytes: &mut usize,
        ret: &mut i32,
        restore_fs_khz: Option<i32>,
    ) {
        self.state.n_bytes_left = 0;
        *action = 1;
        if let Some(fs_khz) = restore_fs_khz {
            self.state.set_fs(fs_khz);
        }
        *used_bytes = self.state.src.buffer_length;
        *ret = Self::map_rc_error(self.state.src.error);
    }

    fn update_fec_state(&mut self) {
        if self.state.vad_flag != 1 {
            return;
        }

        match self.state.frame_termination {
            LAST_FRAME => {
                self.state.no_fec_counter += 1;
                if self.state.no_fec_counter > NO_LBRR_THRES {
                    self.state.inband_fec_offset = 0;
                }
            }
            LBRR_VER1 => {
                self.state.inband_fec_offset = 1;
                self.state.no_fec_counter = 0;
            }
            LBRR_VER2 => {
                self.state.inband_fec_offset = 2;
                self.state.no_fec_counter = 0;
            }
            _ => {}
        }
    }

    fn maybe_resample(&mut self, input: &[i16], api_hz: i32) -> Result<Vec<i16>, i32> {
        let in_hz = (self.state.fs_khz * 1000) as u32;
        let out_hz = api_hz as u32;
        if in_hz == out_hz {
            return Ok(input.to_vec());
        }
        if self.resampler.is_none()
            || self.resampler_in_hz != in_hz
            || self.resampler_out_hz != out_hz
        {
            self.resampler = Some(
                SimpleResampler::new(in_hz, out_hz).map_err(|_| DEC_INVALID_SAMPLING_FREQUENCY)?,
            );
            self.resampler_in_hz = in_hz;
            self.resampler_out_hz = out_hz;
        }
        let rs = self.resampler.as_mut().ok_or(DEC_INVALID_SAMPLING_FREQUENCY)?;
        let out_len =
            rs.output_len_for_input(input.len()).map_err(|_| DEC_INVALID_SAMPLING_FREQUENCY)?;
        let mut out = vec![0i16; out_len];
        let n = rs.process(input, &mut out).map_err(|_| DEC_INVALID_SAMPLING_FREQUENCY)?;
        out.truncate(n);
        Ok(out)
    }

    fn decode_frame(
        &mut self,
        dec_control: &mut DecControl,
        lost_flag: i32,
        in_data: &[u8],
    ) -> Result<Vec<i16>, i32> {
        if self.state.more_internal_decoder_frames == 0 {
            self.state.n_frames_decoded = 0;
        }

        let mut action = if lost_flag != 0 { 1 } else { 0 };
        let mut ret = 0i32;
        if self.state.more_internal_decoder_frames == 0
            && action == 0
            && in_data.len() > MAX_ARITHM_BYTES
        {
            action = 1;
            ret = DEC_PAYLOAD_TOO_LARGE;
        }

        let prev_fs_khz = self.state.fs_khz;
        let mut ctrl = DecoderControl::default();
        let mut used_bytes = 0usize;
        let mut internal_pcm = vec![0i16; self.state.frame_length];

        if action == 0 {
            let fs_khz_old = self.state.fs_khz;
            if self.state.n_frames_decoded == 0 {
                self.state.src.dec_init(in_data);
            }

            if self.state.src.error != 0 {
                self.on_payload_error(&mut action, &mut used_bytes, &mut ret, None);
            } else {
                let out = decode_parameters(&mut self.state, &mut ctrl, true);
                if self.state.src.error != 0 {
                    self.on_payload_error(&mut action, &mut used_bytes, &mut ret, Some(fs_khz_old));
                } else {
                    used_bytes = self
                        .state
                        .src
                        .buffer_length
                        .saturating_sub(self.state.n_bytes_left as usize);
                    self.state.n_frames_decoded += 1;
                    internal_pcm = decode_core(&mut self.state, &mut ctrl, &out.q);
                    let l = self.state.frame_length;
                    plc(&mut self.state, &mut ctrl, &mut internal_pcm[..l], l, false);
                    self.state.loss_cnt = 0;
                    self.state.prev_sigtype = ctrl.sigtype;
                    self.state.lag_prev = ctrl.pitch_l[NB_SUBFR - 1];
                    self.state.first_frame_after_reset = 0;
                }
            }
        }

        let l = self.state.frame_length;
        if action == 1 {
            if internal_pcm.len() < l {
                internal_pcm.resize(l, 0);
            }
            plc(&mut self.state, &mut ctrl, &mut internal_pcm[..l], l, true);
        }

        self.state.out_buf[..l].copy_from_slice(&internal_pcm[..l]);
        plc_glue_frames(&mut self.state, &mut ctrl, &mut internal_pcm[..l], l);
        cng(&mut self.state, &mut ctrl, &mut internal_pcm[..l], l);

        let hp_in = internal_pcm[..l].to_vec();
        biquad(
            &hp_in,
            &self.state.hp_b,
            &self.state.hp_a,
            &mut self.state.hp_state,
            &mut internal_pcm[..l],
        );
        internal_pcm.truncate(l);

        if used_bytes != 0 {
            if self.state.n_bytes_left > 0
                && self.state.frame_termination == MORE_FRAMES
                && self.state.n_frames_decoded < 5
            {
                self.state.more_internal_decoder_frames = 1;
            } else {
                self.state.more_internal_decoder_frames = 0;
                self.state.n_frames_in_packet = self.state.n_frames_decoded;
                self.update_fec_state();
            }
        }

        if !(8_000..=48_000).contains(&dec_control.api_sample_rate) {
            return Err(DEC_INVALID_SAMPLING_FREQUENCY);
        }
        let pcm = self.maybe_resample(&internal_pcm, dec_control.api_sample_rate)?;
        self.state.prev_api_sample_rate = dec_control.api_sample_rate;
        if prev_fs_khz != self.state.fs_khz {
            self.resampler = None;
        }

        dec_control.frame_size = dec_control.api_sample_rate / 50;
        dec_control.frames_per_packet = self.state.n_frames_in_packet.max(1);
        dec_control.more_internal_decoder_frames = self.state.more_internal_decoder_frames;
        dec_control.in_band_fec_offset = self.state.inband_fec_offset;

        if ret != 0 { Err(ret) } else { Ok(pcm) }
    }
}

fn silk_header_len(data: &[u8]) -> Option<usize> {
    if data.starts_with(b"\x02#!SILK_V3") {
        Some(1 + b"#!SILK_V3".len())
    } else if data.starts_with(b"#!SILK_V3") {
        Some(b"#!SILK_V3".len())
    } else if data.starts_with(b"!SILK_V3") {
        Some(b"!SILK_V3".len())
    } else {
        None
    }
}

fn parse_silk_packets(data: &[u8]) -> Vec<Vec<u8>> {
    let mut i = match silk_header_len(data) {
        Some(v) => v,
        None => return Vec::new(),
    };

    let mut packets = Vec::new();
    while i + 2 <= data.len() {
        let n = i16::from_le_bytes([data[i], data[i + 1]]) as i32;
        i += 2;
        if n <= 0 {
            break;
        }
        let n = n as usize;
        if i + n > data.len() {
            break;
        }
        packets.push(data[i..i + n].to_vec());
        i += n;
    }
    packets
}

/// Why a SILK stream decodes to no audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SilkError {
    /// The sample rate asked for is outside 8 to 48 kHz.
    InvalidSampleRate,
    /// The bytes start with no SILK header, or hold no packet after it.
    InvalidOrEmptySilkFile,
    /// Every packet failed to decode.
    NoAudioDecoded,
}

impl std::fmt::Display for SilkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            SilkError::InvalidSampleRate => "invalid sample rate, must be in [8000, 48000]",
            SilkError::InvalidOrEmptySilkFile => "invalid or empty SILK stream",
            SilkError::NoAudioDecoded => "no audio decoded from the SILK stream",
        })
    }
}

impl std::error::Error for SilkError {}

/// The mono 16-bit PCM `silk` (a SILK v3 stream, with or without
/// Tencent's leading 0x02) decodes to, at `sample_rate` Hz.
pub fn decode(silk: &[u8], sample_rate: u32) -> Result<Vec<i16>, SilkError> {
    if !(8000..=48000).contains(&sample_rate) {
        return Err(SilkError::InvalidSampleRate);
    }
    let packets = parse_silk_packets(silk);
    if packets.is_empty() {
        return Err(SilkError::InvalidOrEmptySilkFile);
    }

    let mut decoder = SilkDecoder::new();
    let mut control = DecControl {
        api_sample_rate: sample_rate as i32,
        frames_per_packet: 1,
        ..Default::default()
    };

    let mut pcm_samples: Vec<i16> = Vec::new();
    for packet in &packets {
        while let Ok(samples) = decoder.decode_frame(&mut control, 0, packet) {
            pcm_samples.extend_from_slice(&samples);
            if control.more_internal_decoder_frames == 0 {
                break;
            }
        }
    }

    if pcm_samples.is_empty() {
        return Err(SilkError::NoAudioDecoded);
    }
    Ok(pcm_samples)
}
