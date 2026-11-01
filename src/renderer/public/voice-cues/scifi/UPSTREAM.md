# UI SFX Sci-fi voice cue assets

All three runtime cues use the same CC0 Sci-fi sound family. `wake.mp3` is
played directly when local wake-word detection succeeds, while the connected
and ended cues are derived variants of that source.

## Upstream

- Upstream: https://github.com/romainsimon/uisfx
- Upstream commit: `9950fe66f993a6660dab9c2651dcbcd899ffd83b`
- Source path: `sounds/scifi/wake.mp3`
- Audio license: CC0-1.0, see `LICENSE-AUDIO`

## Cue mapping

| Rambo event | Bundled file | Derivation |
| --- | --- | --- |
| Wake word detected | `wake.mp3` | Original source cue |
| Live connected | `connected.mp3` | First hit unchanged; second hit raised by `+2 semitones` |
| Live ended | `ended.mp3` | First hit lowered by `-2 semitones`; second hit lowered by `-5 semitones` |

## Processing

`wake.mp3` was amplified by `+6.5 dB`, given an 8 ms fade-in, kept mono,
resampled to 44.1 kHz, and encoded at 192 kbps.

For `connected.mp3`, the first hit is taken from `0.000-0.190 s`, followed by a
45 ms gap and the second hit from `0.201-0.340 s` raised by `+2 semitones`
(rate factor `1.122462`) with duration restored. The result uses a gentle
`-2 dBFS` limiter and `+1.2 dB` gain.

For `ended.mp3`, the first hit is lowered by `-2 semitones` (rate factor
`0.890899`) with duration restored, followed by a 55 ms gap and the second hit
lowered by `-5 semitones` (rate factor `0.749154`) with duration restored. The
result uses a gentle `-2 dBFS` limiter and `+1.5 dB` gain.

All three runtime files clear input metadata, remain mono at 44.1 kHz, and are
encoded at 192 kbps. Their measured mean volumes are within `0.3 dB` of the
source wake cue so the player's existing `0.75` volume applies consistently.

## SHA-256

- `wake.mp3`: `f21ee21d214e03d6c167295216e5805c328ca8f457412a131d4b6a52ecc4fbdd`
- `connected.mp3`: `2969330ad97291b5d4552b7a3815bd2758cfa19aed4132611421e337ddef68f8`
- `ended.mp3`: `315595d577a5050640c3616d504bce74e35c11410c42b0d7191d8ef7d68366f7`
