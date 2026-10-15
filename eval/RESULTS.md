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

## F4 — Conversation pipeline (done 2026-10-15)

`ConversationService.turn({ audio, speakerSide })` runs speech-to-text in the
speaker's language, translates, and reads the translation aloud in the other
language. It returns `{ id, sourceLang, sourceText, translation,
backTranslation, fidelity, flags, audioPath, timings }`, plus the full
transcript, check and speech results. The clinician side speaks English and
the patient side Swahili (configurable). Partial results go to `onEvent`
(transcript, audio chunks, translation, check), so a UI can play audio
before the turn is over. All five models stay loaded together: Whisper,
AfriSLM 2B, EmbeddingGemma, and one Chatterbox per language. Warm-up runs
each model once per language (8–10 s) and reports anything the memory
budget evicted.

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 186/186 pass |
| Real-model tests (`npm run test:models`) | 26/26 pass (now one file at a time, see below) |
| Network audit, full eval (275 turns) | no sockets opened |

### Scheduling (what the listener waits for)
1. Speech-to-text (~1.3–1.5 s, the encoder's fixed 30 s window).
2. Each sentence is translated, and **spoken as soon as it is translated**.
3. The back-translation check starts once the first audio has arrived and
   the whole translation exists. It runs while the first sentence plays, and
   its result arrives a median 0.6–1.4 s after the audio starts.

"Turn latency" here means from the end of the utterance to the first
translated audio: how long the listener waits. Synthesis of later sentences
overlaps playback.

### Data
- **intake**: F3's spoken-form renders of the 60 intake sentences
  (synthetic Chatterbox speech), consecutive sentences joined with 0.4 s
  gaps until a turn lasts ≥ 4.5 s. This gives 22 English and 25 Swahili turns
  of 4.5–7.6 s (median 5.8–6.0 s), 2–3 sentences each. This is the "5 s
  utterance" of the budget. The reference is the intake set's other language
  (placeholder, not vetted).
- **fleurs**: the 67 FLEURS test sentences present in both languages, as
  human read speech in each. The other language's FLEURS text is a
  professional reference. Utterances run 4–25 s (median 8.8 s en, 13.7 s sw),
  with long Wikipedia sentences.

Per turn: `eval/outputs/converse.csv`. Summary: `eval/outputs/converse-summary.json`.

### Results (M4, warm, all models loaded)

| Set | Turns | First audio median / p90 | Within 5 s | Speech-to-text | Translation | Check after first audio | chrF spoken / text-only |
|---|---|---|---|---|---|---|---|
| intake, clinician en→sw | 22 | **4.59 / 4.94 s** | 20/22 | 1.35 s | 1.31 s | 1.15 s | 72.7 / 77.7 |
| intake, patient sw→en | 25 | **4.14 / 5.01 s** | 22/25 | 1.48 s | 0.89 s | 1.39 s | 48.1 / 80.4 |
| fleurs, clinician en→sw | 67 | 6.32 / 7.93 s | 12/67 | 1.29 s | 0.96 s | 0.63 s | 59.6 / 61.6 |
| fleurs, patient sw→en | 67 | 5.28 / 6.62 s | 23/67 | 1.48 s | 0.59 s | 0.97 s | 56.4 / 70.9 |

"Translation" is the whole translation; speech starts after the first
sentence. "chrF text-only" translates the reference source text directly. The
gap to "spoken" is what speech recognition costs.

**Budget: met for ~5 s utterances.** In the intake turns of 3.5–6.5 s, first
audio has a median of 4.54 s (en) and 3.99 s (sw), with p90 5.20 and 5.01 s;
42/47 intake turns are within 5 s. Once speech-to-text is done, the wait is
the first sentence's translation and synthesis: median 3.2 s (en→sw) and
2.6 s (sw→en). It grows with the length of the first sentence, so FLEURS's
long sentences (first audio 4.9 s at 3.5–6.5 s, 7.0 s at ≥ 10 s for en→sw)
miss the budget. Timings varied 5–15 % between three full runs (FLEURS en→sw
median 7.0 / 7.5 / 6.3 s); `mediaanalysisd` was using ~1.2 CPU cores
throughout.

### A/B: scheduling (intake turns, each variant run back to back on the same turn)

| Variant | First audio en→sw median / p90 | sw→en median / p90 | Within 5 s | Turns with a stall (total) |
|---|---|---|---|---|
| **streamed (default)**: speak each sentence once translated, check after first audio | **4.59 / 4.94 s** | **4.14 / 5.01 s** | **42/47** | 28/47 (21.4 s) |
| wait-for-translation: speak after the whole translation | 4.70 / 5.04 s | 4.27 / 5.11 s | 41/47 | 29/47 (22.7 s) |
| check-with-speech: as above, check started together with speech | 5.54 / 5.85 s | 5.26 / 6.39 s | 15/47 | 8/47 (2.3 s) |

Decisions:
- **Check after the first audio.** Starting it together with the speech puts
  the back-translation on the GPU next to Chatterbox. That costs 0.7–1.0 s of
  first audio (in all three runs), and the check line would only
  arrive ~1.6 s *before* the audio, which nobody needs.
- **Speak as translated.** It is 0.1–0.2 s faster in every run, less than
  the ~0.7 s spent translating later sentences. The translator keeps working
  on those sentences while Chatterbox synthesizes the first one, and they
  compete for the GPU.
- **Stalls are longer pauses, not cut words.** The check and the later
  translations run while sentence 2 is synthesized, so sentence 2 is late in
  about half the turns (≈ 0.5–0.9 s extra pause on top of the 250 ms sentence
  pause). Synthesis is per whole sentence, so a stall never falls inside a
  sentence. The UI should show "speaking…" until the last audio.

### Memory
- Weights loaded: **5.38 GB** (the plan's 4.5 GB left out EmbeddingGemma and
  the second Chatterbox), under the 10 GB budget. All 5 models stayed
  loaded through 275 turns.
- QVAC worker RSS peaked at **4.76 GB** (a lower bound on Apple Silicon:
  memory-mapped weights, Metal buffers in unified memory).
- The SDK's system "used" memory went from 5.5 GB to a 15.0 GB peak of 16 GB.
  That figure includes the file cache of the model files and every other
  app, so it overstates the app. Practical limit: the model tests failed
  with Metal and decode errors (`T3 step eval failed`, whisper -6/-8) when
  vitest ran the test files in parallel, each with its own QVAC worker and
  model set. `npm run test:models` now runs one file at a time. One
  conversation set fits a 16 GB Mac; two do not.

### Findings
- **Whisper's glued Swahili numbers broke translations.** "Mpe mtoto ml 5 mara
  mbili kwa siku 3" was heard as "mililitatano marambili" and translated as
  "15 milliliters of milk every three days" (`numbers-changed` did fire).
  Swahili transcripts are now un-glued with F1's splitter before anyone
  reads or translates them ("mililita tano mara mbili"; `transcript.ts`).
  On the patient intake turns, flagged number changes went 4 → 2,
  quantities kept 9/15 → 10/15, chrF 47.1 → 48.1. F2/F3 eval numbers predate this
  and were not re-run.
- **The check cannot see speech-recognition errors.** It compares the
  translation with what was *heard*. A number Whisper mishears or drops never
  reaches the check: "mara nne" was heard as "mara ne", "miaka 34" as "miaka
  thilakini nane" → "thirty-eight years old", with no flag. On the Swahili
  side, 5/15 intake turns and 8/21 FLEURS turns lost a quantity (text-only:
  0/15 and 3/21). The UI must show the speaker what was heard
  (the `transcript` event comes first), so the speaker can repeat a number
  that came out wrong.
- **Swahili speech recognition is the weak link**, not translation. On FLEURS,
  speech input costs 14.5 chrF sw→en (70.9 → 56.4) against 2 en→sw
  (61.6 → 59.6). On the synthetic intake speech it costs 32 chrF (80.4 → 48.1),
  but that set is Chatterbox Swahili, which F2 already found hard to
  recognize. Treat 48 as a floor, not a field number.
- **The first sentence's synthesis dominates the wait** (about 2.3–2.8 s of
  the median 4.1–4.6 s). Candidate next steps, not tried here: split a long first
  sentence at a clause break for its own synthesis, or chunk-stream only the
  first sentence (F3: 0.2–0.35 s sooner, with stalls inside the sentence).
- Translated speech is written to `var/conversation/<id>.wav` as plain WAV.
  This is patient audio at rest, unencrypted; retention and encryption belong
  to F9.

## F5 — Content packs (done 2026-10-15)

`ofa pack build <dir>` reads `pack.json`, `cards.csv` and `phrases.csv`
(zod schemas, every problem reported at once by file, row and column),
checks that each referenced recording is a readable WAV inside the
directory, embeds every card in both languages with EmbeddingGemma, and
writes an unsigned `.ofapack`: `manifest.json` (id, version, created, the
embedding model's sha256 and recipe, size and sha256 of every file),
`content.json`, `embeddings.json` and `audio/`. `ofa pack sign` adds
`manifest.sig`, an Ed25519 signature (`node:crypto`) over the manifest's
canonical bytes. `PackLoader.verifyAndLoad()` checks the signature against the
keys built into the app before it parses anything else, then each file's
sha256, the version floor and the content. `PackStore` installs packs and keeps
the newest version ever installed per pack, so an older signed pack cannot come
back even after the newer file is deleted.

Sample content: `content/sample/`, 10 cards and 30 phrases, every item marked
`PLACEHOLDER – NOT CLINICALLY VETTED`; no recordings yet (F6).

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 209/209 pass (23 new) |
| Real-model tests (`npm run test:models`) | 27/27 pass |
| Network audit, F5 eval and `test:models` | no sockets opened |

### Results (M4, sample pack)

| Measure | Result |
|---|---|
| Pack size | 100 KB: `embeddings.json` 81 KB (20 × 768 float32, base64), `content.json` 18 KB |
| Build | 2.2 s cold (loads EmbeddingGemma), 0.17 s warm; signing 3 ms |
| Verify and load | median 0.9 ms, p90 1.3 ms |
| Tamper sweep: every byte of the signed pack flipped in turn | **0 / 102,332 accepted** (all caught by the archive's strict layout and CRCs) |
| Same, with the CRCs repaired after each flip | **0 / 101,902 accepted**: 100,932 hash-mismatch, 861 bad-signature, 94 malformed, 15 unknown-key |
| Recompute on a device with another model hash | 0.18 s for 10 cards; same model gives bit-identical vectors |
| Cross-language: a card's Swahili vector nearest its own English vector | 9/10 (own similarity 0.54–0.77) |

Unit tests also cover: unsigned pack, untrusted key, a signature that claims
a trusted key's id, a manifest edited after signing, a file swapped or
unlisted or missing (re-signed), refusing to sign a pack whose files do not
match, downgrade through the loader and through the store, and unsafe paths.

### Findings
- **The container is a ZIP in one exact layout.** Entries are stored, with fixed
  timestamps and attributes, and the reader cross-checks every header field.
  So every byte is a fixed value, a cross-checked length or offset, a CRC, or
  content under the manifest's sha256: no byte can change unnoticed (both
  sweeps above). Deflate was left out on purpose. Its padding bits can change
  without changing the output, the content barely compresses (vectors and
  WAVs), and storing leaves nothing to decompress on a device. `unzip -l`
  still opens a pack.
- **Canonical JSON is enforced, not just written.** `manifest.json` and
  `manifest.sig` must be byte-identical to their canonical form, and the
  signature's base64 must be canonical. Otherwise a flipped low bit in the
  last base64 character would decode to the same signature and the flip would
  go unnoticed.
- **Key ids are derived, not declared** (sha256 of the public key). A
  signature that copies a trusted key's id fails as `bad-signature`.
- **One cross-language miss: burns.** Its Swahili text is closest to the
  English *wound care* card; its own English card ranks second (0.68). Both
  are injury cards whose steps are to rinse with clean water and cover with
  something clean. F7's hybrid search adds
  keyword matching in both languages and should be measured on real queries
  before tuning the card text recipe (`card-v1`; a recipe change triggers
  recompute on devices).
- The development signing key is unencrypted and git-ignored. Release
  signing needs a vendor key (encrypted with `OFA_PACK_KEY_PASSPHRASE`, or
  kept off the build machine) and a new entry in `trusted-keys.ts` (F10).
