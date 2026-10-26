use std::io::{self, Read, Write};

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_PCM_BYTES: usize = 16 * 1024 * 1024;
const SAMPLE_RATE: u32 = 24_000;

fn write_wav_header(output: &mut impl Write, data_bytes: u32) -> io::Result<()> {
    output.write_all(b"RIFF")?;
    output.write_all(&(36u32.saturating_add(data_bytes)).to_le_bytes())?;
    output.write_all(b"WAVEfmt ")?;
    output.write_all(&16u32.to_le_bytes())?;
    output.write_all(&1u16.to_le_bytes())?;
    output.write_all(&1u16.to_le_bytes())?;
    output.write_all(&SAMPLE_RATE.to_le_bytes())?;
    output.write_all(&(SAMPLE_RATE * 2).to_le_bytes())?;
    output.write_all(&2u16.to_le_bytes())?;
    output.write_all(&16u16.to_le_bytes())?;
    output.write_all(b"data")?;
    output.write_all(&data_bytes.to_le_bytes())
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut silk = Vec::new();
    io::stdin()
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut silk)?;
    if silk.is_empty() || silk.len() > MAX_INPUT_BYTES {
        return Err("input exceeds the WeChat voice size limit".into());
    }

    let samples = silk::decode(&silk, SAMPLE_RATE)?;
    let pcm_bytes = samples.len().saturating_mul(2);
    if pcm_bytes == 0 || pcm_bytes > MAX_PCM_BYTES || pcm_bytes > u32::MAX as usize - 36 {
        return Err("decoded WeChat voice exceeds the output size limit".into());
    }

    let mut output = io::stdout().lock();
    write_wav_header(&mut output, pcm_bytes as u32)?;
    for sample in samples {
        output.write_all(&sample.to_le_bytes())?;
    }
    output.flush()?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("WeChat voice could not be decoded: {error}");
        std::process::exit(1);
    }
}
