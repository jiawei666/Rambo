use sha2::{Digest, Sha256};

const VOICE: &[u8] = include_bytes!("../tone.silk");

#[test]
fn decodes_wechat_voice_to_reference_pcm() {
    let pcm = silk::decode(VOICE, 24_000).expect("decode WeChat SILK sample");
    assert_eq!(pcm.len(), 28_800);
    let bytes: Vec<u8> = pcm.iter().flat_map(|sample| sample.to_le_bytes()).collect();
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        "e155bd2c1622b94428fd3f3574e34fd0e99bcf0ffdbf370711c5f38c957e6168"
    );
}

#[test]
fn rejects_non_silk_input() {
    assert!(silk::decode(b"not a voice message", 24_000).is_err());
}
