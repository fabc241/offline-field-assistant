# Test fixtures

Speech clips from the FLEURS test split ([google/fleurs](https://huggingface.co/datasets/google/fleurs),
CC-BY-4.0, Conneau et al. 2022), re-encoded as 16 kHz 16-bit mono WAV.

| File | FLEURS file | Transcript |
|---|---|---|
| `fleurs-sw-1941-quiet.wav` | `sw_ke/test/11046065003042852689.wav` | Wanandoa hawa wanaweza kuchagua kutengeneza mpango wa ulezi wa mtoto wao. |
| `fleurs-en-1953.wav` | `en_us/test/10899527843662463911.wav` | He was subsequently relocated to Addenbrooke's Hospital in Cambridge. |

The Swahili clip peaks at about -50 dBFS; without level normalization the VAD
drops it as silence.
