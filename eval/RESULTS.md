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

## F3 — Text-to-speech, read aloud (done 2026-10-14)

`Speaker` on Chatterbox multilingual (Q4_0) **on Metal**, one loaded instance
per language (the language is fixed at load). `ReadAloud` speaks sentence by
sentence, so the first sentence plays while the next is synthesized, and
spells out numbers, doses, units, clock times, ratios and ranges first
(`src/features/voice/spoken.ts`). Optional consented reference voice per
language (`OFA_VOICE_EN` / `OFA_VOICE_SW`). It is refused without a consent
record next to the recording.

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 168/168 pass |
| Real-model tests (`npm run test:models`) | 22/22 pass |
| Network audit, full eval (5 variants, 700 renders + 700 transcriptions) | no sockets opened |

### Method (no human listener)
Each of the 60 intake sentences, plus 10 three-sentence paragraphs, is
rendered per language and variant, then transcribed by the F2 Whisper.
- **WER/CER**: hypothesis and reference both go through the spoken form, so
  "500 mg" and "five hundred milligrams" match.
- **Doses heard back**: a sentence passes when every quantity (value and unit)
  comes back unchanged through F1's quantity parser.
- **Stall**: total silence a listener would hear mid-speech if playback started
  with the first audio and the next audio was late.

Whisper's own errors count against the TTS. On real human speech the same
Whisper gets FLEURS CER 8.4 (sw) and 2.0 (en), so that is the floor. Renders:
`var/eval-audio/tts-<variant>-<lang>/` (usable as `eval:stt` sets). Per render:
`eval/outputs/tts-<variant>.csv`. Summary: `eval/outputs/tts-summary.json`.

### Results (sentences; M4, warm)

| Variant | Lang | WER / CER | Doses heard back | First audio median / p90 | RTF median | Sentences with a stall |
|---|---|---|---|---|---|---|
| **spoken (default)** | en | **3.4 / 1.1** | **19/19** | 1.66 / 2.03 s | 0.90 | 0/60 |
| raw (digits as written) | en | 6.0 / 4.2 | 17/19 | 1.88 / 2.26 s | 1.05 | 0/60 |
| stream50 | en | 3.4 / 1.1 | 19/19 | 1.47 / 1.65 s | 1.38 | 45/60 |
| stream25 | en | 3.1 / 1.0 | 19/19 | 1.51 / 1.71 s | 1.70 | 59/60 |
| slow (0.85) | en | 3.4 / 1.2 | 19/19 | 1.82 / 2.19 s | 0.84 | 0/60 |
| **spoken (default)** | sw | **61.4 / 15.3** | **11/21** | 1.93 / 2.68 s | 0.91 | 0/60 |
| raw (digits as written) | sw | 64.6 / 20.1 | 4/21 | 2.01 / 3.12 s | 0.97 | 0/60 |
| stream50 | sw | 62.8 / 16.2 | 10/21 | 1.59 / 1.98 s | 1.37 | 51/60 |
| stream25 | sw | 62.0 / 16.2 | 10/21 | 1.64 / 1.90 s | 1.79 | 59/60 |
| slow (0.85) | sw | 62.8 / 16.7 | 10/21 | 1.99 / 2.79 s | 0.77 | 0/60 |

Paragraphs (default): en first audio 1.67 s for 5.3 s of speech, RTF 0.90;
sw 2.36 s for 6.5 s, RTF 0.95. Load ~0.4–0.9 s per language. The first
synthesis after a load is ~0.3–1 s slower (Metal warm-up).
Timings vary ~10 % between runs (a first full run had en RTF 0.81, sw 0.83).
Quality numbers are identical, since synthesis is seeded and decoding is greedy.

Decisions:
- **Metal on.** The engine defaults to CPU: RTF 3–4.5 on the M4 against ~0.6–0.9
  on the GPU. This also accounts for F2's "0.25× real time".
- **Whole sentences, no chunk streaming.** Chunks start the audio only
  0.2–0.35 s sooner, but each chunk re-runs S3Gen over the speech so far.
  Total RTF rises above 1 and playback would stall in most sentences
  (28–62 s of stalls over 60 sentences). `--chunk-tokens` stays available.
- **Spell numbers out.** Doses heard back: sw 4/21 → 11/21, en 17/19 → 19/19.
  CER sw 20.1 → 15.3, en 4.2 → 1.1. As written, "38.5 °C" came back as
  "3023 °C" in English and "500 mg" as noise in Swahili.
- **Normal speed.** 0.85× did not help (sw CER 16.7).

### Findings
- **No KV-cache reload is needed.** The same sentence, repeated on one loaded
  instance and interleaved with other sentences, gives bit-identical audio
  (real-model test). The distorted or repeated audio problem did not reproduce.
- **English read-aloud is close to clean** (51/60 sentences word-perfect).
- **Swahili stays the weak side.** CER 15.3 against Whisper's 8.4 on human
  Swahili. 10/21 dose sentences still lose a number, through slips such as
  "tatu" → "chatu", "thelathini na nne" → "lakini nenni", "tisini" → "tesini".
  Whisper alone cannot tell whether Chatterbox or Whisper made each slip.
  Treat Swahili read-aloud of doses as unreliable: vetted phrase recordings
  (F6) remain the plan for critical phrases.
- **Swahili numbers are read in counting form** ("vidonge mbili"), not with
  noun-class agreement ("vidonge viwili"), and clock times as written ("saa
  8:00" → "saa nane"). F1's `clock-time` flag covers the meaning.
- **Whisper glues Swahili number words** ("miatano", "kuminambili",
  "marambili"). F1's quantity parser now splits tokens made only of number
  words and units, reads spoken decimals ("nukta tano"), units placed before
  the number ("miligramu mia tano"), and "five hundred thousand" (it gave 1500
  before). F4 feeds Whisper's Swahili into this parser. Rechecked on all 600
  recorded F1 checks: no result changed.
- **Duration flags** (`too-long`, `too-short`) did not fire in 700 renders.
  Observed 48–116 ms per letter (en) and 64–158 (sw). Bounds are set at about
  half and twice that, for gross failures only.
