# Evaluation results

Measured on the dev machine (Apple M4, 16 GB, macOS 27) unless noted.
Each feature appends its section when it reaches "done".

## F0 — Foundation (done 2026-10-14)

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 19/19 pass |
| Real-model tests (`npm run test:models`) | 6/6 pass |
| Models on disk | 8 models, 4.42 GB, all sha256-verified against the registry |
| GPU | Apple M4, Metal, unified memory |
| Load times (first load, warm cache) | translator 2.2 s · Whisper turbo 8.4 s (1.5 s when cached) · Chatterbox mtl 1.5 s · EmbeddingGemma 1.6 s · OCR 0.7 s |
| STT + translator + TTS loaded together | fits; 10.2 s to load all three; peak worker RSS 3.4 GB* |
| Network audit, `ofa doctor --verify --load` | no sockets opened |
| Network audit, real-model tests | no sockets opened |
| Packaged app (Forge + QVAC plugin, arm64) | 574 MB without models; loads OCR from local file; no sockets |

\* RSS undercounts on Apple Silicon: weights are memory-mapped and Metal buffers
live in unified memory. Treat 3.4 GB as a lower bound; the ~4 GB of weights is
the planning figure. Peak memory under real inference is measured in F4.

### Download notes (dev only)
- Dev link ran at ~0.3–0.9 MB/s; the full set took ~1.5 h.
- The QVAC registry relay timed out twice (1.5 GB translator, 788 MB TTS file).
  Fixes: HF-hosted models are fetched directly at the registry's pinned commit
  with the registry sha256; registry timeout raised to 5 min with 10 retries
  (`qvac.config.json`); the fetch script retries 5× and resumes `.part` files.
- The QVAC worker opens UDP (P2P) sockets while downloading from the registry.
  Runtime loads from local files open none; `scripts/net-audit.sh` guards this.

### Toolchain notes
- Node 26 breaks Electron Packager's unzip (`extract-zip` → `yauzl` 2.10 exits
  silently). Fixed with an npm override to `yauzl` 3.4.0.

## F1 — Translation en↔sw with back-translation check (done 2026-10-14)

Dataset: `eval/datasets/intake.csv`, 60 placeholder clinic-intake sentences with
my own Swahili, **not vetted**; chrF against it compares models, nothing more.
Quality is judged by automated tests (chrF and the check-detection tests
below). Side-by-side outputs:
`eval/outputs/translate-<model>.csv`. Raw numbers: `eval/outputs/translate-summary.json`.

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 52/52 pass |
| Real-model tests (`npm run test:models`) | 10/10 pass |
| Network audit, full eval (3 models, 720 translations) | no sockets opened |

### A/B: TranslatePsy-AfriSLM sizes (Q4_K_M, warm, per sentence)

| Model | Size | chrF en→sw | chrF sw→en | Translate median / p90 | Check median (back-translation + embed) |
|---|---|---|---|---|---|
| 0.8B | 672 MB | 75.3 | 75.2 | 0.17 / 0.22 s | 0.14–0.17 s |
| **2B (default)** | 1.56 GB | **78.0** | **80.1** | 0.35 / 0.46 s | 0.28–0.37 s |
| 4B | 3.07 GB | 77.9 | 79.9 | 0.80 / 1.04 s | 0.67–0.82 s |

Decision: keep **2B**. 4B is no better on this set, 2.3× slower and twice the
memory, and makes its own errors (breastfeeding → "unyevu", moisture). 0.8B is
2× faster but loses ~3 chrF and makes more visible errors ("vomiting" →
"ukichelewa", being late).

### What the checks catch (2B)

Perturbations applied to the English sources, scored as if they were the
back-translation; the last column counts flags on the real round trips.

| Check | Catches | Flags on real round trips |
|---|---|---|
| `negation-changed` | 56/56 negation flips | 0/60 |
| `numbers-changed` | 19/19 number changes | 0/60 en→sw; 1/60 sw→en (i60: the back-translation really did turn "saa mbili" into "saa 8:00") |
| `low-fidelity` (cosine, EmbeddingGemma "sentence similarity" prompt) | 60/60 unrelated sentences; 19/56 negation flips; 10/19 number changes | 1/60 en (i24, read back as "trauma"); 1/60 sw (i33, a false flag: "VVU" vs "virusi vya UKIMWI") |
| `clock-time` | i60 in every model, both directions | — |

Fidelity distribution (min / p05 / median): faithful en round trips 0.81 / 0.88 / 1.00;
sw round trips 0.74 / 0.81 / 0.98; negation flips 0.78 / 0.81 / 0.87; number
changes 0.70 / 0.70 / 0.83; unrelated 0.38 / 0.39 / 0.49. Cross-lingual
source↔translation similarity was tried and rejected: faithful and wrong
translations overlap across 0.6–0.75.

### Findings
- **Clock times are copied digit for digit.** "8:00 in the morning" → "saa 8:00
  asubuhi", which a Swahili listener reads as 2 p.m. (8 a.m. is "saa mbili
  asubuhi"). All three sizes do it; the `clock-time` flag fires every time.
  Candidate follow-up: a deterministic Swahili-time hint next to the flag.
- **Fidelity only catches gross meaning loss.** Negations and numbers score as
  high as faithful round trips, hence the rule-based checks. Swahili
  paraphrases score lower than English ones, so thresholds are per source
  language (en 0.85, sw 0.75).
- **Terminology is the main residual risk, and it passes every check.** "syrup"
  → "mchuzi" (broth/paste) in 0.8B and 2B, fidelity 0.93, no flag; the
  back-translation text ("5 ml of the broth") shows it to a reader. Unresolved
  without a reference: "vomiting" → "ukimwaga" (2B; all models read it back as
  vomiting) and "convulsions" → "mshtuko" rather than the usual "degedege".
  Fixed phrasebook entries (F6) are the mitigation for critical phrases.
- **Same-model round trips can mask errors**, so the service accepts a separate
  `backTranslator`. On this set, 2B forward with 0.8B or 4B back flagged nothing
  new and added one false flag (4B reads "nikikuchunguza" as "spy on you"); the
  default stays same-model.
- Swahili has no gendered pronouns: "She is 34" round-trips to "He is 34". Not a
  translation error, but the back-translation can mislead a reader.

## F2 — Speech-to-text (done 2026-10-14)

`Transcriber` on Whisper large-v3-turbo with Silero VAD, Metal, greedy
decoding, language **forced** per request. One loaded instance serves both
languages: switching is a config hot-reload, not a second model.
Audio is decoded in TypeScript (WAV 8/16/24/32-bit int, 32/64-bit float,
any channel count → 16 kHz mono f32, windowed-sinc resampling) and
peak-normalized before Whisper. `@qvac/decoder-audio` runs only inside the
worker and only for file paths, so it would not cover in-memory audio from
the push-to-talk recorder.

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 103/103 pass |
| Real-model tests (`npm run test:models`) | 15/15 pass |
| Network audit, full eval (2 models, 720 transcriptions) | no sockets opened |

### Data
- **FLEURS** test split (google/fleurs, CC-BY-4.0, pinned commit): 150 clips
  per language, one speaker per sentence; Swahili is `sw_ke` (Kenya).
  Read speech on general topics (Wikipedia sentences), median 13 s per clip.
- **Intake (synthetic)**: 30 intake sentences per language rendered with
  Chatterbox. A clinic-vocabulary stand-in until real recordings exist; it
  measures TTS + STT together.
- WER/CER after lowercasing and stripping punctuation (`eval/wer.ts`);
  numbers are not spelled out, which matters for Swahili (below).

### A/B: stock Whisper turbo vs Paza (Microsoft's Kenyan-language fine-tune)

| Model | FLEURS sw WER / CER | FLEURS en WER / CER | Intake-TTS sw WER / CER | Intake-TTS en WER / CER | Decode median / p90 (FLEURS sw) |
|---|---|---|---|---|---|
| **large-v3-turbo (kept)** | **32.0 / 8.4** | **4.5 / 2.0** | 78.8 / **26.8** | **6.2 / 3.9** | 1.27 / 1.44 s (RTF 0.09) |
| Paza turbo (MIT) | 37.7 / 20.4 | 52.3 / 39.6 | 78.8 / 55.2 | 143.6 / 162 | 1.46 / 8.5 s |

Decision: keep **stock large-v3-turbo**. Paza gets more Swahili sentences
exactly right (9 vs 4 of 150) and was slightly better on WER over the first 40
clips (30.3 vs 33.7), but in whisper.cpp's greedy decoder it often keeps
generating past the speech: invented text, sometimes in Kalenjin/Maasai-like
words, decoding to the 10 s limit (28 sw and 44 en clips took > 5 s; stock: 0).
English is badly damaged. The app needs one model for both sides, so Paza
is out. Hugging Face decodes Paza with `no_repeat_ngram_size: 3`, which
whisper.cpp has no equivalent for; `no_timestamps: true` made it worse
(WER > 300 %).

Paza was converted locally (`npm run import-paza`, no torch): stock ggml file as
template, the 5 added language tokens cut from the vocabulary. Checked by
comparing each tensor with stock: relative difference median 3.5 %, max 25 %
(a mis-mapped tensor would be ~140 %), frozen positional embedding identical.
Jacaranda's Swahili Whisper (whisper-medium fine-tune, CC-BY-SA-4.0) was
not tried: medium decodes slower than turbo and its weights are share-alike.

### Findings
- **Quiet recordings vanished before level normalization.** 11/150 FLEURS sw
  clips (peaks ≈ -54 dBFS) came back as no speech in ~30 ms: the Silero VAD
  dropped them. Peak normalization (to 0.7, gain ≤ 60 dB) fixed all 11; WER
  38.3 → 32.0. Silence, white noise from -60 to -20 dBFS and mains hum still give
  `no-speech` in both languages, with no invented text.
- **~1 s latency floor.** Every clip costs ~1.0–1.1 s, whatever its length,
  because the encoder always processes a 30 s window. Shrinking it with
  `audio_ctx` halves latency but costs accuracy (en intake WER 6.2 → 16.4 at
  750; sw 34 → 54), so it stays off. Budget ~1.2 s for STT in F4.
- **Swahili numbers come out as words.** Whisper writes "2.4 GHz" as
  "gigahezi mbili nukta nne" and years as "elfu moja mia tano…"; part of the
  FLEURS sw WER is that style, not misrecognition (CER 8.4 vs WER 32). F4 must
  feed this into F1's Swahili number-word parser, not expect digits.
- **Residual Swahili errors are near-misses**: vowel or consonant slips
  ("kujagua" for "kuchagua", "madara" for "madhara"), word splits/joins
  ("moja wapo"), proper nouns. English is close to clean (73/150 exact).
- **Chatterbox Swahili is hard to understand.** The same Whisper that reads
  FLEURS sw at 8.4 CER gets 26.8 on Chatterbox Swahili; English TTS gives 3.9.
  Errors include numbers read as wrong words ("38.5" → "trajime …"). Chatterbox
  also synthesized at ~0.25× real time using ~4 CPU cores (60 clips: 7.4 min).
  Both are F3 risks to measure first.
- Resampling 10 s of 48 kHz audio takes ~0.3 s; the recorder should deliver
  16 kHz directly.
