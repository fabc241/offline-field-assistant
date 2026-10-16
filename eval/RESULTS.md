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
- **Known wrong meanings are now flagged (`term-changed`).** Recording the demo
  video turned up two more terminology errors that passed every check: "Is he
  drinking?" → "Je, anakunywa pombe?" (read back as "Does he drink alcohol?",
  fidelity 0.94) and "oral rehydration solution" → read back as "a mouthwash"
  (0.86); checking the video's replacement line found "loose stool" → "kinyesi
  kizito", a heavy stool (0.92). With "syrup" → broth they form `eval/datasets/term-traps.csv`
  (`npm run eval:term-traps`). The fidelity threshold cannot separate them
  (faithful round trips go as low as 0.81), and a generic "the back-translation
  adds a content word" rule caught all three but also 22/60 faithful round
  trips (stomach → "abdomen", pass urine → "urinate"). `term-changed` instead
  lists the wrong meanings themselves (alcohol, mouthwash, broth, hard stool) and
  fires when the back-translation has one the English source lacks: 4/4 traps caught, and
  on the 367 English round trips saved by the other evals (three sizes,
  cross-model back-translations, documents) it fires only on i45, the real
  syrup → broth error. It catches only meanings on its list: a new trap goes
  into the dataset first, then into the list in `checks.ts`.
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

## F6 — Phrasebook (done 2026-10-15)

`Phrasebook` (`src/features/phrasebook/`) reads phrases from a verified pack:
`list(category)`, `get(id)`, `search(text, lang)`, `audioPath(id, lang)` and
`recording(id, lang)`. The last returns the WAV bytes exactly as they were
signed into the pack. Nothing in the phrasebook can synthesize speech: it
imports no speaker, and a unit test pins its imports. A phrase without a
recording in both languages fails the pack build, the loader and the
phrasebook. There is no runtime fallback. `ofa phrase list|search|play` needs
no model.

Placeholder recordings: `npm run make-phrase-recordings` renders each phrase
that has no recording with Chatterbox's built-in voice. It writes
`<file>.wav.synthetic.json` (engine, language, text, sha256 of the WAV, seed,
what Whisper heard), and the build tags the file `synthetic: true` in the
signed manifest. The build refuses a record whose WAV or phrase text has
changed since it was made, so the tag cannot drift. A WAV without a record is
taken as a human recording and is never overwritten. Recordings are also
checked for silence (peak below −60 dBFS) and length (at most 30 s).

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 230/230 pass (21 new) |
| Real-model tests (`npm run test:models`) | 29/29 pass (2 new) |
| Network audit: F6 eval, F5 eval and `test:models` | no sockets opened |

### Results (M4, sample pack 0.2.0: 30 phrases, 60 synthetic recordings)

| Measure | Result |
|---|---|
| Pack size | 4.9 MB (recordings 24 kHz 16-bit mono, 1.0–3.4 s each) |
| Open: verify the signed pack, load and index the phrasebook | median 2.8 ms, p90 3.6 ms |
| Time to audio: phrase id → decoded samples | median 0.11 ms, max 1.0 ms (read-aloud's first audio, F3: 1.66 s en, 1.93 s sw) |
| Search, top 3 on keyword, partial, typo and mixed queries (target ≥ 90 %) | **103/104 (99 %)**; top 1 103/104; median 0.10 ms per query |
| … by language | en 51/52, sw 52/52 |
| Word forms (vomiting, kupumua …) | 7/8 |
| Synonyms (pain → "Where does it hurt?") | 0/8, as expected for keyword search |
| Recordings heard back by Whisper, en | WER 0.6 / CER 0.1, 29/30 word for word (the miss: "diarrhoea" → "diarrhea") |
| Recordings heard back by Whisper, sw | WER 54.5 / CER 10.5 (F3 read-aloud: 61.4 / 15.3) |

Queries: `eval/datasets/phrase-queries.csv`, 120 in all. I wrote them
alongside the search code, so the hit rate is optimistic: real users' queries
must re-measure it. Per query: `eval/outputs/phrasebook-search.csv`. Per
recording: `eval/outputs/phrasebook-recordings.csv`.

A/B, matching the other language's text at weight 0.8 vs not at all: top 3
103/104 vs 98/104. The difference is all in mixed queries ("homa" typed on
the English side, "homa ya child"): 8/8 vs 3/8. Nothing else changed, so 0.8
is the default.

Word forms went from 3/8 to 7/8 once a query word could also match without
English -ing/-ed or the Swahili infinitive ku- (at 0.9 weight). The one form
still missed, "kuhara", is a different word from "-harisha".

The F5 eval was re-run on the larger pack. The tamper sweeps now flip every
byte outside the recordings, plus each recording's 64-byte header and every
499th byte after it (`--audio-stride`). Results: 0/137,069 accepted, and
0/129,111 with the CRCs repaired. Verify and load: 2.6 ms median (0.9 ms
without recordings).

### Findings
- **Seeded synthesis also repeats its mistakes.** As first rendered (engine
  seed 42 for every phrase), "Please wait here." came out twice in one 1.4 s
  take: two bursts of speech with silence between them. Read-aloud's
  duration flags did not fire (100 ms per letter is within bounds); Whisper
  heard "Please wait here. Should we wait here?". Re-rendering gives the same
  take, but Chatterbox takes a `seed` (`TtsOptions.seed`). The generator now
  has Whisper hear each take. A take above CER 10 (en) or 20 (sw) is rendered
  again with seeds 1, 2 and 3, and the best one is kept. 12 of 60 recordings
  needed more than one take (11 sw, 1 en); hist-age (sw) used all four and
  kept CER 30.8.
- **The before/after gain partly measures Whisper choosing what Whisper
  understands.** Before retakes: en WER 3.1 / CER 2.7, sw 69.6 / 18.0. After:
  en 0.6 / 0.1, sw 54.5 / 10.5. Using the same Whisper both to choose the take
  and to score it inflates the gain. The English doubled take was a real
  defect; the Swahili gains are less certain.
- **A low CER can still hide the key word.** The kept "Una homa?" is heard as
  "Una Roma?": CER 12.5, within the threshold, but *homa* (fever) is the
  point of the phrase. Character error rate does not weight words. These
  recordings are placeholders. Each needs replacing with a native speaker's
  recording of the vetted phrase. The worst five by CER are listed in
  `eval/outputs/phrasebook-summary.json`, and every record keeps what Whisper
  heard.
- **Synthetic is a manifest tag, not a file name.** It is signed with
  everything else, `ofa pack verify` counts it, and `ofa phrase play` prints
  "synthetic placeholder (text-to-speech), not a native speaker". The UI must
  show the same.
- **Keyword search does not know synonyms** (0/8): "pain", "temperature" and
  "joto" find nothing. With 30 phrases, browsing by category covers that. The
  F7 guide brings embedding search, and the phrasebook could reuse it if
  phrase counts grow.
- The packs are now about 50× larger (4.9 MB vs 100 KB) and that is fine.
  Verifying hashes every recording at each open (2.8 ms), and nothing is
  decompressed.

## F7 — Ask the guide (measured 2026-10-15; top-3 target not met)

`Guide` (`src/features/guide/`) answers a typed or spoken question with
cards from a verified pack, in the language asked. The guide generates
nothing. A `GuideResult` is either `match`, with 1–3 cards, or `no-match`,
with "No match in the guide — see a clinician." in the asked language. It is
never empty. Each card has `dangerSigns` before `steps`, both non-empty
tuples, in that key order in the JSON as well. A unit test pins `guide.ts`'s
imports: no translator, speaker or model runtime.

Search has two halves, and both score every card:
- **Keywords** (`keyword-index.ts`): BM25 over each card's text in both
  languages plus its tags, with the title counted twice, so a query that mixes
  languages still finds its card. Query words match the way the phrasebook's
  do (word starts, parts of words, typos from 5 letters, -ing/-ed/ku-). Two
  more forms are added: English plurals and Swahili verbs without their
  subject and tense ("anatapika" → "tapika", found in "kutapika"). English and
  Swahili function words are dropped. **Coverage** is the share of the query's
  words a card matches, each weighted by rarity (as in the phrasebook).
- **Meaning**: the query embedded with EmbeddingGemma (`query` prompt) and
  compared by cosine with the pack's card vectors, taking the closer of the
  two languages. Confidence is the **lift** over the median card for that
  query, not the raw cosine. Swahili queries sit closer to every card than
  English ones (off-topic Swahili around 0.5, off-topic English around 0.35),
  so a raw cosine threshold would mean different things in the two languages.

A card is offered when coverage ≥ 0.45 or lift ≥ 0.17. Offered cards rank by
coverage + 2 × lift, with BM25 breaking ties. Without an embedding model,
with stale pack vectors, or when the embedder throws, search runs on keywords
alone and the result says why (`mode`, `degraded`). `searchByVoice` runs F2
speech to text in the given language, then `search()`, and returns what was
heard alongside the result; nothing heard means no match. `ofa guide` needs
no model for `--card` or `--keyword-only`.

**Thresholds and fusion were chosen on a separate tuning set**,
`eval/datasets/guide-dev.csv` (40 in-scope and 14 out-of-scope questions),
before the eval queries were run. Each threshold sits midway in the gap on
the tuning set: out-of-scope maxima were coverage 0.39 ("ng'ombe wangu ni
mgonjwa" → burns, via *mgonjwa*) and lift 0.158 ("dog bite" → burns); the
lowest in-scope values above them were 0.5 and 0.18. Nothing was changed after
the eval queries were run.

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 250/250 pass (20 new) |
| Real-model tests (`npm run test:models`) | 32/32 pass (3 new) |
| Network audit: F7 eval, `test:models`, `ofa guide --voice` | no sockets opened |

### Results (M4, sample pack 0.2.0: 10 cards)

Queries: `eval/datasets/guide-queries.csv`, 100 in scope (10 per card, 50
en and 50 sw, 20 of each kind) and 20 out of scope. I wrote them, as with
F6, so real users' questions must re-measure this. A hit is the expected card
among the at most 3 the guide offers. With 10 cards, picking 3 at random
would hit 30 %.

| Measure | Result |
|---|---|
| **Top 3, all 100 (target ≥ 90 %)** | **80/100: not met**; top 1 79/100 |
| … keyword, question, typo, mixed (the kinds the plan names, plus questions) | 75/80 (94 %) |
| … synonym (words the card does not use: "burning up", "scalded", "the runs") | 5/20 |
| … by language | en 41/50, sw 39/50 |
| Out-of-scope questions answered "no match — see a clinician" | **20/20** |
| A wrong card offered in place of the right one | 0: all 20 misses were "no match"; 1 hit was at rank 2 |
| Tuning set, same settings | 37/40 top 3 (all top 1), 14/14 out of scope |
| Open: verify the signed pack, index the cards | median 2.9 ms |
| Search, hybrid | median 7.7 ms (embedding the query 7.2 ms); keyword only 0.007 ms |
| Spoken question to answer (Whisper + search) | median 1.05 s |

Top 3 by kind, default settings: keyword 20/20, question 19/20, typo 17/20,
mixed 19/20, synonym 5/20.

**A/B on the same 100 (top 3 / top 1; out of scope answered "no match"):**

| Variant | Top 3 | Top 1 | en | sw | Out of scope |
|---|---|---|---|---|---|
| Hybrid, score fusion (default) | **80** | **79** | 41 | 39 | 20/20 |
| Hybrid, reciprocal-rank fusion (the plan's) | 80 | 78 | 41 | 39 | 20/20 |
| Keyword only | 71 | 70 | 33 | 38 | 20/20 |
| Meaning only | 39 | 39 | 34 | **5** | 20/20 |

**Spoken questions** (keyword, question and synonym kinds: 60 questions
read by Chatterbox's built-in voice, heard by Whisper large-v3-turbo):

| | Spoken | Same, typed | Whisper heard |
|---|---|---|---|
| en | 20/30 | 23/30 | WER 9.4 / CER 4.1 |
| sw | **4/30** | 21/30 | WER 73.1 / CER 17.8 |

Per query: `eval/outputs/guide-search.csv` (each variant) and
`guide-voice.csv` (what was heard). Summary and the threshold sweep:
`eval/outputs/guide-summary.json`.

### Findings
- **The 90 % target is missed on synonyms, not on matching.** On the kinds
  keyword search covers, top 3 is 75/80. Synonyms reach 5/20: the meaning
  half rarely lifts a card by 0.17 when no keyword matches. Every miss fails
  safe: the guide says "see a clinician" and shows no wrong card.
- **Lowering the lift threshold buys synonyms at the cost of out-of-scope
  safety.** The eval sweep gives 86/100 at lift 0.12 with 20/20 out of scope
  still refused. But the tuning set had "dog bite" at lift 0.158, which 0.12
  would answer with the burns card. The sweep ran on the eval queries, so it
  cannot be used to pick a value. Picking one needs a fresh query set, ideally
  real field questions.
- **Meaning search does not work for Swahili on its own** (5/50 against 34/50
  English). EmbeddingGemma puts every Swahili text about as close to every card,
  so a Swahili lift rarely clears 0.17. Swahili relies on keywords (38/50
  alone). That is why confidence is a lift and not a raw cosine, and why the
  word forms matter.
- **Reciprocal-rank fusion lets a weak meaning signal outrank a full keyword
  match.** On the tuning set it got 37/40 top 1 against 40/40 for coverage +
  2 × lift. In "mtoto ana homa na kutapika", fever-child has coverage 0.88, but
  meaning ranks malnutrition first (lift 0.09). Malnutrition also matches the
  common word *mtoto*, so being in both lists wins under RRF. On the eval set
  the two are within one query (top 1 79 vs 78). Both stay in code (`fusion`).
- **Typo misses are short words.** "chld", "adlt" and "mzma" are 4 letters,
  below the phrasebook's 5-letter typo floor (kept so that "kula"/"kila" do not
  match). An unmatched word counts most against coverage, so one such word
  sinks the query. Allowing one typo at 4 letters is a candidate, and it needs
  new queries to measure.
- **Some missing words are content gaps, not search gaps.** The cards say
  *ujauzito* (pregnancy) but never *mjamzito* (pregnant woman), the word
  people use. So "mama mjamzito anatoka damu" misses in both query sets. The
  card authors can fix this in `tags` with no code change.
- **Spoken Swahili questions mostly fail, but the synthetic speech is the
  cause.** Whisper heard "homa mtoto" as "Omam tuipo" and "kikohozi mtoto" as
  "Ki kuhosim toto" (WER 73, against FLEURS human Swahili CER 8.4 in F2). These
  are Chatterbox placeholders, so 4/30 is a floor for synthetic speech and not
  a field number. Very short English queries also suffer: "burns" was heard
  as "earns fat", "child cough" as "Child called?". The UI must show what was
  heard (`transcript`) before the cards.
- With 10 cards the index is in memory and a search takes about 8 ms, almost
  all of it the query embedding. Keyword scoring is linear in the vocabulary
  (expansions are cached per query word) and stays well under a millisecond
  at the plan's ~50 cards.

## F8 — Document translate (done 2026-10-15)

`DocumentService` (`src/features/documents/`) takes a photo or a PDF and
returns its text as segments in reading order. Each segment is translated
with the F1 check and carries `{ page, bbox, original, translation,
ocrConfidence, flags }`.
- **PDF**: the text layer, read with pdf.js. A page with fewer than 20
  letters and digits is a scan. It is rendered with `@napi-rs/canvas` at up
  to 3 px per point and OCR'd.
- **Photo** (PNG, JPEG, HEIC, BMP, WebP, TIFF; the kind is judged by the
  bytes): turned upright from its EXIF orientation by `sharp`, flattened,
  capped at 2560 px and OCR'd. HEIC goes through macOS `sips`, since the
  prebuilt `sharp` has no HEVC decoder.
- **Straightening** (`deskew.ts`): the tilt is the angle that gives the
  sharpest horizontal projection of the ink, searched over ±8° in ~13 ms.
  Pages tilted by 0.3° or more are rotated before OCR, and boxes are mapped
  back to the original.
- **OCR** runs `OCR_LATIN` + `OCR_CRAFT` line by line on Metal, with the
  engine's rotated retries off. The engine's paragraph mode merged an English
  line with the Swahili one below it and kept only the lowest confidence, so
  `layout.ts` groups lines itself. Boxes on one row join into a line, and a
  gap wider than 1.5 line heights splits fields. A line continues the
  paragraph above it only when all of these hold: centre-to-centre spacing
  ≤ 1.35 line heights, similar height, aligned, the line above does not end a
  sentence or a label, the new line does not start a field ("Date of birth:")
  or a list item, and the language does not switch.
- **Confidence**: the engine scores a line as the product of its character
  probabilities raised to 2/√n, so a 52-letter line read perfectly scored
  0.59. The service takes the per-character geometric mean instead. A
  segment's confidence is that of its weakest line.
- **Translation**: the direction is fixed by `--to` (the other language is
  the source). A segment already clearly in the target language, or one
  without a 3-letter word (dates, "14.5 kg"), is kept as printed (`kept`).
  OCR'd segments below 0.85 get `low-confidence`, listed first. They are
  still translated: flags never block, as in F1.

`ofa doc translate FILE --to sw [--out result.json] [--no-check] [--json]`
prints each segment as it is translated. `ofa doc read FILE` prints the text
only.

**F1 change: a new flag, `translation-loop`.** On a label heading
("AMOXICILLIN 250 mg CAPSULES") the 2B translator looped until its 256-token
cap ("…ugonjwa wa ugonjwa wa…") and no check fired. The flag uses F2's
repetition detector. It fires on that output and on none of the 1,130
earlier F1 and F4 eval translations. It is named apart from the speech flag
`repetition` because a conversation turn reports both.

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 271/271 pass (21 new) |
| Real-model tests (`npm run test:models`) | 36/36 pass (4 new) |
| Network audit: F8 eval, `test:models`, `ofa doctor --load`, `ofa doc translate` | no sockets opened |

### Data

`eval/datasets/documents.json` holds 15 placeholder forms and labels,
**NOT clinically vetted**; the Swahili is my own and not vetted. Each is
written as text with its layout, and `eval/make-documents.ts` renders it to
`var/eval-docs/`, so the written text is the ground truth. The renderings:
PDFs with a text layer; scanned PDFs (a JPEG per page, no text); and phone
photos simulated from the page on a table, tilted 1–3.5°, shaded, blurred,
noisy, downscaled and saved as JPEG 50–85 or HEIC. One is stored sideways
with EXIF orientation 6. **The 10 eval documents (12 pages) were measured
once, with the settings chosen on the 5 dev documents.** These are rendered
fonts and simulated damage, not real phone photos. Real forms, handwriting
(out of scope) and creased paper must be re-measured.

A block is **intact** when one segment matches it within 15 % character
error, so a block merged with another or split apart does not count.
**Numbers** are digit groups as printed (14.5, 12/03/2019, 0712); one counts
as read when the same string appears on the page.

### Results (M4, warm)

| Measure | All 12 pages | Text layer (3) | OCR (9) |
|---|---|---|---|
| CER, strict (case and punctuation count) | 3.3 % | **0 %** | 5.0 % |
| CER, normalized (as F2's WER) | 1.9 % | 0 % | 2.8 % |
| Blocks intact | 89/95 | 31/31 | 58/64 |
| Numbers read exactly | 39/42 | 11/11 | 28/31 |
| Time to read a page (median / max) | — | 8 ms / 11 ms | 4.4 s / 7.5 s |

| Document | Kind | CER strict / normalized | Blocks | Numbers | Read |
|---|---|---|---|---|---|
| e01 intake form (en) | PDF, text | 0 / 0 | 15/15 | 7/7 | 11 ms |
| e02 discharge (sw, 2 pages) | PDF, text | 0 / 0 | 16/16 | 4/4 | 7 ms |
| e03 medicine label (en) | JPEG photo | 1.4 / 0 | 7/7 | 6/6 | 4.1 s |
| e04 ORS sachet (en + sw) | JPEG photo, EXIF sideways | 0.7 / 0 | 8/8 | 4/4 | 4.9 s |
| e05 vaccination card (en) | scanned PDF | 0.8 / 0 | 11/11 | 10/10 | 3.8 s |
| e06 referral letter (en, 2 pages) | scanned PDF, A4 | 1.7 / 1.0 | 11/11 | 3/3 | 7.5 s/page |
| e07 medicine label (sw) | HEIC photo, dim | 3.1 / 0 | 6/6 | 4/4 | 4.4 s |
| e08 clinic notice (sw) | PNG screenshot | 2.2 / 0 | 5/5 | 1/1 | 3.0 s |
| e09 consent form (en) | JPEG photo, A4, small text | 9.6 / 4.5 | 6/8 | 0/1 | 5.7 s |
| e10 lab slip (en) | JPEG photo, typewriter, blurred | 26.0 / 22.3 | 4/8 | 0/2 | 2.1 s |

**Translation** of the 10 eval documents into their other language (97
segments; 3 Swahili lines of the bilingual sachet kept as printed):

| Measure | Result |
|---|---|
| Time per page: read, translate, check (median / p90 / max) | 12.4 / 14.0 / 14.1 s |
| Drift, text-layer pages (chrF of the read text's translation against the true text's) | 100 on all 3 |
| Drift, OCR pages (median / lowest) | 88.8 / 53.2 (e10 lab slip) |
| Peak worker RSS (OCR + translator + embedder) | 0.83 GB (RSS undercounts, see F0) |

**Low-confidence flag** (a segment counts as misread when any word differs
from the page's text):

| | Dev (chose 0.85) | Eval at 0.85 |
|---|---|---|
| Misread segments flagged | 6/11 | **9/17** |
| … with a misread number | 4/5 | 3/4 |
| Clean segments flagged | 1/18 | **0/49** |
| AUC: per-character mean / engine's raw score | 0.84 / 0.85 | 0.92 / 0.90 |

The threshold sits midway in the dev gap: misread segments up to 0.77,
clean ones from 0.92. On the eval set, 0.92 would flag 12/17 misread
segments with no clean one, and 0.94 would flag 14/17 with 1/49 clean. That
sweep ran on the eval documents, so it cannot be used to choose a value
(as in F7).

**A/B on the dev documents** (4 OCR pages; strict / normalized CER, blocks
intact, numbers, median / max read time, AUC):

| OCR setting | CER | Blocks | Numbers | Read | AUC |
|---|---|---|---|---|---|
| Engine defaults (magnify 1.5, retry unsure lines at 90°/270°) | 9.6 / 7.8 | 23/28 | 19/24 | 4.8 / 8.2 s | 0.82 |
| **No rotation retries (app)** | **9.5 / 7.7** | 23/28 | 20/24 | 4.7 / 7.7 s | 0.84 |
| … magnify 1.0 | 10.6 / 8.4 | 23/28 | 21/24 | 2.4 / 7.9 s | 0.86 |
| … magnify 2.0 | 10.2 / 7.8 | 23/28 | 21/24 | 7.2 / 7.9 s | 0.90 |
| … scans rendered at 2 px/pt instead of 3 | 10.2 / 8.3 | 22/28 | 19/24 | 4.7 / 7.2 s | 0.91 |
| No straightening (app settings otherwise) | 18.8 / 17.4 | 16/28 | 19/24 | 4.0 / 6.9 s | — |

On the eval OCR pages, straightening also halves the error: without it,
strict CER is 9.3 % (5.0 % with it), with 51/64 blocks intact (58/64 with
it).

Per segment: `eval/outputs/documents-segments.csv` (read text, confidence,
word and number errors) and `documents-translations.csv` (translation,
back-translation, flags). Summary: `eval/outputs/documents-summary.json`.

### Findings
- **Text PDFs are exact and instant**: 0 % CER and every block intact, read
  in about 10 ms. The time goes to translation: per sentence, 0.35 s to
  translate and 0.3 s to check (F1).
- **Straightening is what makes photos usable.** The engine boxes are
  axis-aligned, so at a 2° tilt the two ends of a printed line sit a line
  apart. The pieces then sorted into the wrong order ("…three times a day
  days. Finish…"). Removing the tilt first halves CER on both sets and keeps
  blocks whole.
- **Confidence catches the badly read lines, not single-letter slips.** On the
  blurred lab slip, 7 of 9 segments scored 0.27–0.81 and were flagged, but
  "LABORATORY RESULI" (0.97) and "Noroge" for "P. Njoroge" (0.99) were not.
  On the dev documents, "TABLEIS", "Hallma" and "mzimna" scored 0.93–0.98. One dev misread is
  dangerous and scored 0.94: "kidonge 1 mara mbili" came back as "kidonge
  mara mbili", with the dose digit dropped. A flag cannot be the only
  safeguard. **The UI must show the photo crop (`bbox`) beside every
  translation**, and medication doses still need the clinician's reading.
- **OCR drops punctuation, and the translation notices.** Final full stops,
  the dash in "SAMPLE - NOT" and slashes ("15/10 2026") go missing. The clean
  PNG (e08) and the dim HEIC label (e07) have 0 % normalized CER, yet their
  translations drift to chrF 86 because the translator reads an unpunctuated
  line differently. A lost full stop also lets two lines join. The
  language-switch rule stops this for bilingual labels; for same-language
  lines (e09) it still happens.
- **The translation check catches translator errors on documents too.**
  "has vomited four times" → "amepiga mara nne" (*has hit four times*;
  `negation-changed` fired on the back-translation). "saa tatu asubuhi" →
  "3am", when it means 9 a.m. (`clock-time`). "REFERRAL NOTE" → "Taarifa ya
  Upelelezi", an investigation report (`low-fidelity`). Drug names and
  personal names in short lines raise `untranslated` (6 times), which is
  expected for "PARACETAMOL 500 mg".
- **Time per page is about 12 s with the check.** An OCR page takes 2–7.5 s;
  the A4 scan is slowest at 3 px/pt. Magnify 1.0 halves the median read time
  for +0.7 points of normalized CER, a trade to revisit on phones.
  Rendering scans at 2 px/pt saved little and lost a block and a number.
- **Platform notes:** HEIC needs macOS (`sips`); the Android build will need
  another HEIC decoder. `sharp` and `@napi-rs/canvas` are native modules and
  must be unpacked from the asar archive in F10. pdf.js 6 has no eval path,
  and its fonts load from the package on disk, so reading a PDF opens no
  socket.

## F9 — Platform: keys, encrypted logs, license (done 2026-10-15)

`src/features/platform/` holds three pieces, wired into every `ofa` command
through `src/cli/session.ts`:
- **`KeyProvider`** (`keys.ts`) holds a random 256-bit log key in a
  `SecretVault`. The CLI uses the macOS Keychain through `/usr/bin/security`.
  The secret goes in on stdin (`security -i`), so it never shows on a command
  line that `ps` could read. The Electron app uses `safeStorage`: the key is
  in an encrypted file whose own key is in the Keychain
  (`electron/key-check.ts` runs it in a real Electron app). A key that
  already exists is never replaced, so two processes that race to make the
  first key both end up with the same one.
- **`SecureLog`** (`secure-log.ts`): append-only JSONL, one file per UTC day,
  mode 0600. Each line is encrypted on its own with AES-256-GCM. The
  envelope carries the key id, the writer's session, the line's number in
  that session and day, the IV, the ciphertext and the tag. The day, key id,
  session and number are bound to the ciphertext as additional data. Lines
  must be byte-for-byte canonical, and the plaintext is padded to 64-byte
  blocks. Day files older than 30 days are deleted on every write and read.
  `wipe` deletes the files and then the key.
- **`ActivityLog`** (`activity.ts`) decides what is recorded: feature,
  action, outcome, languages, timings, counts, flags, models (NAME@sha256
  prefix), pack id@version, and app and SDK versions. Every metadata string
  must be a single token (no spaces), so a sentence cannot slip in. Errors
  are recorded by kind, never by message. Text from people (transcripts,
  translations, queries, OCR text) and the ids of the cards and phrases used
  go in `content`, which is kept only with `OFA_LOG_TRANSCRIPTS=1`. A
  failure to log is reported once on stderr and never fails the command.
- **`License`** (`license.ts`): `{ licensee, seats, issued, expiry, features,
  deviceId? }`, signed with Ed25519 by a vendor key compiled into
  `license-keys.ts`. The vendor keys are kept apart from the pack keys, and
  the signed bytes start with a domain string, so a pack signature cannot
  pass as a license. The license is checked once at start-up, never online.
  `valid` opens the listed features. `expired`, `missing`, `invalid` and
  `wrong-device` open the app read-only: the guide and the phrasebook only.
  The device id is a hash of IOPlatformUUID, `XXXX-XXXX-XXXX-XXXX`.

Commands: `ofa license show|device-id|install|keygen|issue` and
`ofa logs status|export|wipe`; `ofa doctor` shows both. Commands that need a
licensed feature refuse with the reason and record the refusal.

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 319/319 pass (48 new) |
| Real-model and system tests (`npm run test:models`) | 40/40 pass (4 new: Keychain, device id, Electron safeStorage across launches) |
| Network audit: F9 eval (incl. 7 real-model CLI runs), `test:models` | no sockets opened |

### Results (M4)

| Measure | Result |
|---|---|
| Keychain: make the key / read it | 46 ms / median 11 ms (one `security` process each) |
| Electron safeStorage | key ready in 13 ms; same key on the next launch, 3/3 records read back, wipe removes it; 0.27 s per launch |
| CLI start-up check (license + device id + versions) | median 8.5 ms (8.4 ms of it is `ioreg`); the first record adds the 11 ms Keychain read |
| Append one activity record | median 0.05 ms, p99 0.09 ms (10,000 records) |
| Read and verify | 10.5 µs per line (10,000 lines in 105 ms) |
| Size | 986 bytes per line for a 591-byte record (base64, padding, envelope) |
| Log tamper sweep: every bit of every byte of a 3-day, 12-line log flipped in turn | **0 / 94,368 read back without a problem** (54,978 tampered, 38,460 malformed, 528 unknown-key, 390 missing-lines, 12 out-of-order) |
| License check | median 0.05 ms |
| License tamper sweep: every bit of a 617-byte license flipped | **0 / 4,936 accepted** |

| Deliberate edit to the log | Detected as |
|---|---|
| Delete a middle line / the first line of a day | missing-lines |
| Duplicate a line | out-of-order |
| Swap two lines | missing-lines, out-of-order |
| Move a line to the same position in another day | tampered |
| Append a line from another day | tampered, out-of-order |
| Replay a line written with an old (wiped) key | unknown-key |
| Cut off the last line of a day | **not detected** |
| Delete a whole day file | **not detected** |

| License | Status | Opens |
|---|---|---|
| Valid; or bound to this device | valid | everything listed |
| Expires in 10 days | valid + `expires-soon` | everything listed |
| Clock before the issue date | valid + `clock-behind` | everything listed |
| Expired, missing | expired / missing | guide, phrasebook |
| Signed by an untrusted key | invalid (unknown-key) | guide, phrasebook |
| Untrusted signature claiming the vendor key id; expiry edited after signing; pack-style signature without the license domain | invalid (bad-signature) | guide, phrasebook |
| Reformatted (same JSON, other bytes) | invalid (malformed) | guide, phrasebook |
| Bound to another device | wrong-device | guide, phrasebook |

**End to end through the real CLI** (separate processes, scratch log,
Keychain item and license; real models). `translate`, `stt`, `speak`,
`converse`, `guide`, `phrase search` and `doc read` each left one record
(8 with the license install). No record had `content`. Of the 73 words (5+
letters) that people typed, said, heard or read in these runs, three appear
in the decrypted log, all as the code's own field values. "speak" is the
action name; it matched the phrase "Please speak slowly". "patient" is the
conversation side, and "sample" is in the pack id `sample-intake@0.2.0`. No
word appears outside those fixed-name fields. The raw files contain none of
the 6+ letter words, and none of the field names (`feature`, `outcome`, …).
With `OFA_LOG_TRANSCRIPTS=1` the typed sentence and the guide question are
in the decrypted log, and still not in the raw files. With an expired
license, `translate` exits 1 ("translate is not available. The license for F9
eval expired on 2026-10-01: read-only mode (phrasebook and guide only)"),
while `guide` and `phrase play` still work. Both refusals are recorded, and
so is the refused install of the expired file. `logs wipe` without `--yes`
does nothing. With it, the log restarts with one `logs/wipe` record. The old
raw lines, copied back in, are 3 × unknown-key: unreadable.

### Findings
- **What the log cannot notice.** Each session numbers its lines, so a gap
  or a repeat shows a deletion or a reorder. Lines cut from the very end of a
  session, or a whole day file deleted, leave no gap. Catching that would need
  a running count kept outside the files (for instance in the Keychain), which
  every writer would have to update.
- **Sessions keep concurrent writers apart.** Two `ofa` processes writing at
  once each number their own session, so neither breaks the other's sequence
  and there is no lock. A writer that died mid-line is detected: the next one
  starts a fresh line, and only the partial line reads as `malformed`.
- **Metadata still says something.** Timings and languages show that a
  conversation happened and how long it took. Card and phrase ids would show
  what it was about (`hiv-testing`, say), so they go in `content` with the
  transcripts, not in metadata.
- **Retention follows the device clock.** A clock set years ahead deletes the
  whole log at the next write.
- **The license is a lock against forgery and casual sharing, not against
  the clock.** Offline, turning the clock back keeps an expired license
  valid. A stored "latest time seen" would stop that, but it would also lock
  out a device that once booted with a wrong future date, even after the
  clock is fixed. Never locking a clinic out matters more, so there is no
  such check. A clock before the issue date only warns. Seats cannot be
  counted offline; `--device` binds a license to one Mac.
- **The read-only floor is the guide and the phrasebook.** They only look up
  content already on the device, and they carry the danger signs. Pack
  installs need a valid license, because read-only means nothing new is
  installed. `logs export`, `logs wipe` and `license install` always work.
- **Review access is the Keychain.** Whoever can read the login Keychain
  item can export the log. The export is written 0600 and never over an
  existing file, and the export itself is recorded. A supervisor-only export
  (encrypted to a reviewer's key) is not built.
- **Dev-only artifacts.** The license key `keys/ofa-license-dev-2026.key.pem`
  (git-ignored) and the dev license in `var/license/` are for this Mac only;
  F10 swaps in the vendor's release key. Dev runs of `electron/key-check.ts`
  use the unbranded Electron binary, so its safeStorage key sits in a
  Keychain item called "Electron Safe Storage"; the packaged app will have
  its own.

## F10 — Packaging: Electron app, model pack, release gate (2026-10-16; gate run on the dev Mac, not on a clean machine)

- **App** (`electron/main.ts`, bundled with esbuild into `build/`): a tray
  icon and a hidden, sandboxed page (context isolation, no Node, CSP
  `default-src 'none'`, every non-`file:` request cancelled, every permission
  refused, navigation and new windows blocked). The page's only way in is
  `window.ofa.invoke(channel, request)` from the preload. There are 22
  channels for the F1–F9 services (`src/app/contract.ts`). The main process
  checks each request against a zod schema. Audio and documents travel as
  bytes, never as paths. Each call answers with an envelope that carries an
  error code (`not-licensed`, `pack-refused`, `unreadable-input`, …), and
  conversation turns can stream their partial results on `ofa:event`.
  `src/app/services.ts` gates and logs each call as the matching `ofa`
  command does, with no Electron in it, so unit tests drive it with a fake
  SDK. The same binary runs any `ofa` command in-process
  (`offline-field-assistant ofa doctor`), so a clinic Mac needs no Node.
  Everything lives in `OFA_HOME`, by default
  `~/Library/Application Support/OfflineFieldAssistant`. The log key is kept
  with safeStorage.
- **Model pack** (`src/features/models/model-pack.ts`, `ofa models …`): a
  folder holding `manifest.json`, `manifest.sig` and `files/`, signed with
  the F5 Ed25519 code and pack keys. Models are too big for the `.ofapack`
  ZIP (4 GB limit, read into memory). Install checks the signature before
  anything else, hashes each file as it copies it into a staging folder, and
  swaps the files in only once all of them are there. A model already on
  the device with the signed hash is kept. Older versions are refused, and
  the files of models a newer pack dropped are removed.
- **Packaging** (`npm run package`): Forge with the QVAC plugin, arm64, with
  an allowlist of `build/`, production `node_modules` and the worker bundle.
  Signing is inside out (`scripts/macos-sign.ts`): every Mach-O file, then
  every bundle, then the app, all with the hardened runtime and
  `electron/entitlements.plist`. The signatures are checked, then the app is
  zipped with ditto. `npm run package:release` adds notarytool and stapler,
  and refuses to run without a Developer ID identity, a notary profile and
  the vendor's own keys.
- **Release gate** (`scripts/release-gate.sh`, shell only): installs the app
  from its zip, then the license, the model pack and the content pack
  through the app's own binary. It then runs `ofa doctor --verify --load`
  and the IPC smoke suite: 25 calls made from the hidden page, each answer
  checked. Every process in the app's tree is watched with lsof throughout.

| Check | Result |
|---|---|
| Unit tests (`npm test`) | 352/352 pass (33 new: model pack, IPC services and contract, runtime, packaging) |
| Real-model and system tests (`npm run test:models`) | 42/42 pass (2 new: `ofa` commands in-process in Electron, IPC smoke suite in the hidden window) |
| IPC smoke, dev Electron and packaged app | 25/25 both |
| Release gate (packaged app, scratch app home) | **PASS**: 6/6 steps, 0 non-loopback sockets in any step |

### Results (M4, 16 GB, macOS 27)

| Measure | Result |
|---|---|
| App | 647 MB (Electron 287 MB, node_modules 348 MB, worker bundle 10 MB); zip 260 MB |
| Signing | 71 Mach-O files and 8 bundles, all hardened runtime; `codesign --verify --deep --strict` valid; ad hoc (this Mac has no Developer ID certificate), so Gatekeeper: **rejected** |
| Entitlements | allow-jit, allow-unsigned-executable-memory, disable-library-validation, audio-input, camera |
| `npm run package` | 24 s (bundle, Forge, sign 2.3 s, check, zip 15 s) |
| `npm run package:release` on this tree | refused: no identity, no notary profile, 2 development keys |
| Model pack | 8 models, 4.42 GB; build 5.7 s (APFS clones, sources hashed), sign 1.8 s, verify 1.8 s (hash everything) |
| Model pack install, internal SSD | fresh 7.5 s (0.59 GB/s, copy and hash); same pack again 1.7 s (nothing copied) |
| Gate: install from zip / license / model pack / content pack | 4 s / 2.5 s / 10.3 s / 0.2 s |
| Gate: `doctor --verify --load` | 10.4 s; loads 0.7–1.6 s per model from the installed pack |
| Gate: IPC smoke | 51.8 s for 25 calls; e.g. translate en→sw with check 3.4 s (first load), speech 2.1 s for 9.8 s of Swahili, conversation turn first audio 4.1 s, scanned PDF 8.4 s, photo translated 16.9 s |

| Model pack change | Refused as |
|---|---|
| One byte changed in the middle of Whisper (1.5 GB) after signing, fresh device | hash-mismatch after 8.1 s of copying; nothing left behind |
| The same, over installed models with an older Whisper | hash-mismatch; installed models and manifest unchanged, no staging left |
| `manifest.json` version edited | bad-signature |
| Signed with an unknown key | unknown-key |
| Version 0.9.0 over 1.0.0 | downgrade |

### Findings
- **OCR next to the conversation models read worse, with no error.** In the
  first app smoke run the conversation set (~5.8 GB) was still loaded when a
  document came in. A scanned page then gave 2 of its 7 text blocks, or none,
  and the next OCR call failed with `ggml_backend_graph_compute failed`. The
  runtime's budget counts weights, not the detector's working memory on a
  large page. OCR now runs **exclusive**: the runtime lets the other models
  finish their calls, unloads them, and holds new calls until OCR is done
  (`ModelSpec.exclusive`). The next conversation turn reloads its models
  (~10 s, F4). Pure calls (OCR, embedding, translation, transcription) are
  also retried once after a GPU allocation error, with the idle models freed
  first. The smoke suite now needs at least 6 of 7 blocks from each page,
  because "found something" would have passed the broken read.
- **The hardened runtime works with these entitlements.** The ad hoc,
  hardened app loads the Bare worker, all five engines, sharp, the canvas
  renderer and pdf.js. HEIC goes through `sips`. Library validation has to
  stay off: the add-ons are not signed with the app's team id.
- **Networking could not be switched off from inside the test.**
  `sandbox-exec` with IP denied stops Chromium's helpers from starting their
  own sandbox, so the gate samples every process's sockets with lsof every
  0.2 s, as F0 and F9 did. A connection shorter than that could be missed.
  The real gate is a clean Mac with networking off. On top of that the app
  cancels every non-`file:` request from its page and starts Chromium with
  background networking, component updates and pings off. The QVAC worker
  talks to the app over a Unix socket only.
- **Keychain prompts on ad hoc builds.** safeStorage keeps its key in the
  Keychain item "<app name> Safe Storage", which only the code identity that
  made it can read without asking. The first packaged run tried to read an
  item a dev `electron .` run had made, and macOS showed a prompt: the run
  hung until it was stopped. Dev runs now name themselves "Offline Field
  Assistant Dev", so they get their own item. Each ad hoc build is still a new
  identity, so the gate on this Mac runs with `--key-store keychain`: a
  scratch item owned by `/usr/bin/security`, deleted afterwards. A Developer
  ID build keeps its identity across versions and does not hit this. The
  packaged app's safeStorage path was therefore **not** exercised here; F9
  exercised the same code in dev Electron.
- **Not done here, needs the vendor:** signing with a Developer ID
  certificate, notarization, release keys in place of the development keys,
  and the gate on a clean macOS 14 machine with networking off, with a
  license issued for that machine. The gate script and the kit layout are
  ready for it.
- `translate a photo` flags `translation-loop` on one segment of the
  medicine label: the F1 check catching the translator repeating itself, as
  designed.
- The `.ofapack` and model-pack keys are the same pack keys, so whoever can
  sign content can also sign models. Separating them is one more
  `trusted-keys` list, if a program needs it.
