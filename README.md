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
| `npm run ofa -- pack build content/sample` | Validates a pack's CSVs and recordings (every problem at once), embeds the cards, writes an unsigned `.ofapack` to `var/pack-builds/` (`--out FILE`) |
| `npm run ofa -- pack sign --key keys/NAME.key.pem PACK` | Signs a pack with Ed25519 (in place; `--out FILE`). `ofa pack keygen --out keys/NAME` makes a key pair |
| `npm run ofa -- pack verify PACK` | Checks a pack against the app's built-in keys and prints what is in it (`--json`; `--trust PUB.pem` adds a key for this check only) |
| `npm run ofa -- pack install PACK` / `pack list` | Verifies and installs a pack into `var/packs/` (`OFA_PACKS_DIR`), refusing any version older than one installed before |
| `npm run eval:packs` | F5 eval: build and load times, every-byte tamper sweeps, vector recompute, cross-language card alignment → `eval/outputs/` |
| `npm run ofa -- phrase list` / `phrase search --lang sw "…"` | Phrases of the installed pack (`--category C`, `--json`; `--pack ID` when more than one is installed); keyword search that forgives word fragments, small typos and some word forms |
| `npm run ofa -- phrase play --lang sw ID` | Plays a phrase's recording exactly as it is in the pack, never text-to-speech (`--out FILE.wav`, `--no-play`) |
| `npm run make-phrase-recordings [-- DIR]` | Dev only: placeholder recordings for phrases that have none, made with Chatterbox's built-in voice, heard back by Whisper (a badly heard take is rendered again with another seed), and marked synthetic (`--force`: make them all again) |
| `npm run eval:phrasebook` | F6 eval: open and time-to-audio, search hit rate per query kind, what Whisper hears in each recording → `eval/outputs/` |
| `npm run electron:smoke` | Runs the Electron main process, which loads a model and exits |
| `npm run package` | Packages the arm64 app with Electron Forge + the QVAC plugin |

## Reference voices

Read-aloud uses Chatterbox's built-in voice unless `OFA_VOICE_EN` / `OFA_VOICE_SW`
point to a recording of a native speaker (mono WAV, at least 5 s of clean speech).
A voice is cloned only with a consent record next to it, `<file>.wav.consent.json`:

```json
{ "speaker": "Full name", "consentDate": "2026-10-01", "scope": "What they agreed to" }
```

## Content packs

Guidance cards and phrases reach a device as a signed `.ofapack`, built from a
directory of CSVs (see [`content/sample/`](content/sample/) and
`src/features/packs/content.ts` for the columns). The app accepts only packs
signed by a key in `src/features/packs/trusted-keys.ts`.

Every phrase needs a recording in each language; the phrasebook plays it as
it is and never falls back to text-to-speech. Until a native speaker records
a phrase, `npm run make-phrase-recordings` makes a placeholder with
Chatterbox and writes `<file>.wav.synthetic.json` next to it. The pack tags
those recordings `synthetic` and the app says so. To replace one, put the
native recording in its place and delete its `.synthetic.json`. The build
refuses a synthetic record whose WAV or phrase text has changed since it was
made.

The development key is `keys/ofa-dev-2026.key.pem`, git-ignored and on the dev
machine only; it is not for release. Set `OFA_PACK_KEY_PASSPHRASE` before
`pack keygen` to encrypt a new key, and before `pack sign` to use it.

## Rules

- Only `src/core/qvac.ts` imports `@qvac/sdk`. Features depend on the interfaces in
  `src/core/engines.ts` (`Translator`, `Embedder`, …) and are unit-tested with fakes.
- At runtime, models load from local files listed in `models/manifest.json`
  (sha256-pinned). Registry, HTTP and P2P sources are refused.
- Install with `npm ci` only; the lockfile pins the SDK's add-on packages.
