# Offline Field Assistant (headless core)

Offline English ↔ Swahili assistant for clinic intake staff, built on the QVAC SDK
(`@qvac/sdk` 0.21.0, pinned). This repo contains the headless core, a CLI (`ofa`)
and a windowless Electron shell. The UI comes later and will call the same services.

> Content in `content/sample/` is placeholder data and is **NOT clinically vetted**.

## Setup

```bash
npm ci
npm run fetch-models        # online, once: ~4.7 GB into models/
npm run ofa -- doctor --verify --load
```

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests with fake models (fast, offline) |
| `npm run test:models` | Integration tests against the real models |
| `npm run ofa -- doctor [--verify] [--load]` | Checks models, memory, GPU; `--load` loads each model |
| `npm run ofa -- translate --from en --to sw "…"` | Translates with a back-translation check (`--plain`: no check, `--json`: full result; no text: reads stdin) |
| `npm run eval:translate` | F1 eval: intake set in both directions for each installed AfriSLM size → `eval/outputs/` |
| `npm run ofa -- stt --lang sw clip.wav` | Speech to text with the language forced (`--json`: segments and timings; `--model NAME`: another Whisper in the manifest) |
| `npm run fetch-fleurs` | Online, once: 150 FLEURS test clips each in Swahili and English → `var/eval-audio/` |
| `npm run eval:make-intake-audio` | Renders 30 intake sentences per language with Chatterbox → `var/eval-audio/` |
| `npm run import-paza` | Online, once: downloads Microsoft's Paza Whisper (3.2 GB) and converts it to whisper.cpp format in `models/` |
| `npm run eval:stt` | F2 eval: WER/CER of each installed Whisper on every speech set → `eval/outputs/` |
| `npm run ofa -- speak --lang sw "…" --play` | Reads text aloud: numbers and units spelled out, sentence by sentence (`--out FILE.wav`, default `var/speech/`; `--chunk-tokens N`: chunk streaming; `--raw`: text as written; `--json`: timings and flags; no text: reads stdin) |
| `npm run eval:tts` | F3 eval: speed (RTF, first audio, stalls) and intelligibility (what Whisper hears back) per variant → `eval/outputs/` |
| `npm run ofa -- converse --side clinician turn.wav --play` | One conversation turn: speech to text, translation, read-aloud in the other language, with the back-translation check alongside (`--side patient`: Swahili speaker; `--out-dir DIR`, default `var/conversation/`; `--json`: timings and every partial result) |
| `npm run eval:converse` | F4 eval: end-to-end turns with all models loaded: time of each stage, wait for the first translated audio, peak memory, chrF against reference translations → `eval/outputs/` |
| `npm run electron:smoke` | Runs the Electron main process, which loads a model and exits |
| `npm run package` | Packages the arm64 app with Electron Forge + the QVAC plugin |

## Reference voices

Read-aloud uses Chatterbox's built-in voice unless `OFA_VOICE_EN` / `OFA_VOICE_SW`
point to a recording of a native speaker (mono WAV, at least 5 s of clean speech).
A voice is cloned only with a consent record next to it, `<file>.wav.consent.json`:

```json
{ "speaker": "Full name", "consentDate": "2026-10-01", "scope": "What they agreed to" }
```

## Rules

- Only `src/core/qvac.ts` imports `@qvac/sdk`. Features depend on the interfaces in
  `src/core/engines.ts` (`Translator`, `Embedder`, …) and are unit-tested with fakes.
- At runtime, models load from local files listed in `models/manifest.json`
  (sha256-pinned). Registry, HTTP and P2P sources are refused.
- Install with `npm ci` only; the lockfile pins the SDK's add-on packages.
