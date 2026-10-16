# Offline Field Assistant (headless core)

Offline English ↔ Swahili assistant for clinic intake staff, built on the QVAC SDK
(`@qvac/sdk` 0.21.0, pinned). This repo contains the core, a CLI (`ofa`)
and an Electron app whose window (`electron/renderer/`) calls the same services
over typed IPC (`src/app/contract.ts`) through `window.ofa`.

> Content in `content/sample/` is placeholder data and is **NOT clinically vetted**.

## Setup

```bash
npm ci
npm run fetch-models        # online, once: ~4.7 GB into models/
npm run ofa -- doctor --verify --load
```

Without a license the CLI opens read-only (phrasebook and guide only). On the
dev machine, issue a development license for this Mac and install it:

```bash
npm run ofa -- license issue --key keys/ofa-license-dev-2026.key.pem --id ofa-dev-mac --licensee "OFA development" --seats 1 --expiry 2027-10-15 --device "$(npm run -s ofa -- license device-id)" --out var/license/dev.ofalicense
npm run ofa -- license install var/license/dev.ofalicense
```

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests with fake models (fast, offline) |
| `npm run test:models` | Integration tests against the real models |
| `npm run ofa -- doctor [--verify] [--load]` | Checks models, memory, GPU; `--load` loads each model |
| `npm run ofa -- translate --from en --to sw "…"` | Translates with a back-translation check (`--plain`: no check, `--json`: full result; no text: reads stdin) |
| `npm run eval:translate` | F1 eval: intake set in both directions for each installed AfriSLM size → `eval/outputs/` |
| `npm run eval:term-traps` | Terminology traps: sentences where a clinical term has come back with another meaning (alcohol, mouthwash, broth); counts the ones `term-changed` catches and its flags on every saved English round trip → `eval/outputs/` |
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
| `npm run ofa -- guide "mtoto ana homa na kutapika"` | Ask the guide: the pack's cards that answer the question, danger signs first, or "no match — see a clinician"; never a generated answer (`--lang`, guessed if omitted; `--limit N`; `--keyword-only`; `--json`; `--pack ID`) |
| `npm run ofa -- guide --voice clip.wav --lang sw` / `guide --card ID` | The same question spoken (speech to text, then search; prints what was heard) / one card in full |
| `npm run ofa -- doc translate form.pdf --to sw --out result.json` | Translates a photo (PNG, JPEG, HEIC, …) or PDF segment by segment, each with the back-translation check; text PDFs give their text layer, scans and photos are straightened and OCR'd, and badly read lines are flagged `low-confidence` (`--no-check`, `--json`) |
| `npm run ofa -- doc read form.jpg` | The text found, by segment, with OCR confidence (`--json`: pages, boxes) |
| `npm run eval:documents` | F8 eval: renders placeholder forms and labels as PDFs, scans and phone photos (`var/eval-docs/`), then OCR character error rate, intact segments, numbers read, the low-confidence flag, time per page and translation drift → `eval/outputs/` |
| `npm run ofa -- license show` / `license device-id` | The installed license, its mode (full or read-only) and the features it opens / this Mac's device id, for a license bound to it |
| `npm run ofa -- license install FILE` | Checks a license file against the built-in vendor keys and this device, then installs it (`OFA_LICENSE`, default `var/license/license.ofalicense`) |
| `npm run ofa -- license issue --key KEY --id ID --licensee NAME --seats N --expiry YYYY-MM-DD` | Vendor only: signs a license (`--features a,b` or `all`, `--device ID`, `--out FILE`); `license keygen --out keys/NAME` makes a vendor key |
| `npm run ofa -- logs status` / `logs export [--out FILE]` / `logs wipe --yes` | The encrypted activity log (`OFA_LOG_DIR`, default `var/logs/`): what is kept and whether every line checks out / decrypted records for review, one JSON per line (`--since`, `--until`) / deletes every file and the log key |
| `npm run eval:platform` | F9 eval: Keychain and Electron safeStorage timings, log speed, every-bit tamper sweeps of a log and a license, license scenarios, and the real CLI checked to log metadata only → `eval/outputs/` |
| `npm run eval:guide` | F7 eval: top-3 hit rate on 100 questions per kind and language, out-of-scope questions answered "no match", fusion A/B, spoken questions read by Chatterbox and heard by Whisper → `eval/outputs/` |
| `npm run ofa -- models status` / `models install DIR` | The installed models and the signed model pack they came from / verifies a model pack (e.g. on a USB stick) and installs it into `OFA_MODELS_DIR`, hashing every file as it copies |
| `npm run ofa -- models build --out DIR` / `models sign --key KEY DIR` / `models verify DIR` | Vendor only: packs this machine's runtime models into a model pack (APFS clones), signs it with a pack key, checks one (`--id`, `--version`, `--models A,B`) |
| `npm run build:electron` | Bundles the Electron main process, preload, the window's page and the tray icon into `build/` |
| `npm run ui:preview` | The window's page in a browser at http://localhost:5178, with sample data in place of the services (`?license=read-only`, `?models=missing`, `?pack=none` show those states) |
| `npm run electron:smoke` | Builds, then checks the page starts and runs the IPC smoke suite in a hidden window against the real models (`OFA_HOME`, `OFA_MODELS_DIR` as for any run; on the dev machine `OFA_HOME=$PWD/var OFA_MODELS_DIR=$PWD/models`) |
| `npm run package` | Packages the arm64 app (Forge + QVAC plugin), signs it inside out with the hardened runtime (Developer ID from `OFA_SIGN_IDENTITY`, else ad hoc), checks the signatures and zips it → `out/` |
| `npm run package:release` | The same, refused unless `OFA_SIGN_IDENTITY` is a Developer ID Application identity, `OFA_NOTARY_PROFILE` is set and no development key is trusted; notarizes and staples |
| `npm run release-gate -- KIT [--home DIR] [--key-store keychain]` | The release gate, shell only (runs on a clean Mac without Node): installs the app from its zip, then the license, model pack and content pack, runs `ofa doctor --verify --load` and the IPC smoke suite, with every process watched for sockets |
| `npm run eval:packaging` | F10 eval: package, release-policy refusal, model pack build/sign/verify/install with full-size tamper refusals, and the release gate on a kit in `var/release-kit/` → `eval/outputs/` |

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

The guide searches the cards by keyword in both languages and by meaning
with the card vectors computed at build time. It offers a card only when one
of the two is confident about it (thresholds in `src/features/guide/guide.ts`);
anything else gets "no match — see a clinician".

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

## Documents

`ofa doc translate` reads a PDF's text layer as it is. A page with almost no
text (a scan), or any photo, is turned upright from its EXIF orientation,
straightened (tilt up to 8°) and read by OCR (`OCR_LATIN` + `OCR_CRAFT` on
Metal). Lines are regrouped into segments: a field, a heading, or a paragraph
wrapped over several lines. Each segment is translated with the F1 check.
Segments already in the target language, and bare numbers or dates, are kept
as printed. Each segment keeps its page and box (points for a PDF, pixels of
the upright photo) so a screen can place the translation over the original.
OCR'd text read with low confidence is still translated but flagged
`low-confidence` first; confidence misses some single-letter slips, so the
original must stay visible beside the translation.

HEIC photos are converted with macOS's `sips` (the prebuilt image library
has no HEVC decoder). Elsewhere, HEIC is refused with a request for JPEG.
`sharp` and `@napi-rs/canvas` are native modules; the packaged app has no
asar archive (the QVAC plugin turns it off), so they load as they are.
OCR runs with no other model loaded: next to the conversation models it ran
short of GPU memory and silently found fewer lines.

## License and activity log

The license is a JSON file signed with Ed25519 by the vendor (keys in
`src/features/platform/license-keys.ts`, separate from the pack keys). It is
checked once at start-up, never online. A valid license opens the features it
lists. Expired, missing, forged or for another device, it opens the app
read-only: the phrasebook and the guide stay available, so a clinic is never
locked out of the danger signs. A license that expires mid-session changes
nothing until the next start. Seats cannot be counted offline; a license with
`--device` opens only on that Mac.

Every command records what it did in an append-only log, one file per UTC day,
each line encrypted on its own with AES-256-GCM. The 256-bit key is in the
macOS Keychain (`OFA_KEYCHAIN_SERVICE`, default "Offline Field Assistant"); the
Electron app keeps it with `safeStorage` (`electron/key-check.ts`). By default
only metadata is recorded: feature, timings, flags, languages, models and pack
used, outcome. What people said, typed or read is recorded only with
`OFA_LOG_TRANSCRIPTS=1`. Lines older than 30 days are deleted. A line that was
edited, moved, duplicated or removed from the middle of a session shows up in
`logs status` and `logs export`; lines cut from the very end, or a whole day
deleted, do not. `logs wipe` deletes the key too, so copies of old lines left
on the disk can no longer be read.

## The app and its packaging

`npm run package` makes `out/Offline Field Assistant-darwin-arm64/` and a zip.
The app is a window with a Dock icon, plus a tray icon (Open, Quit, license
and models status). Closing the window keeps the app and its loaded models
running; Quit ends it. The window's page is sandboxed and its only way in is
`window.ofa.invoke(channel, request)`. Each channel's request is checked against a schema in the main
process; audio and documents travel as bytes, never as paths; every call
resolves to `{ ok, value }` or `{ ok: false, error: { code, message } }`,
checks the license and is logged like the matching `ofa` command. The page
may load nothing but its own files; the only permission it gets is the
microphone and camera, for its own page, and macOS still asks once.

The same binary runs any `ofa` command without Node:

```bash
"/Applications/Offline Field Assistant.app/Contents/MacOS/offline-field-assistant" ofa doctor --verify --load
```

The installed app keeps everything in `~/Library/Application Support/OfflineFieldAssistant`
(`OFA_HOME`): `models/`, `packs/`, `license/`, `logs/`, and the log key
encrypted with safeStorage (`log-key.bin`). Models do not ship in the app:
they come as a signed **model pack**, a folder (`manifest.json`,
`manifest.sig`, `files/`) signed with a pack key, copied to a USB stick and
installed with `ofa models install /Volumes/USB/ofa-models-1.0.0`. The
signature is checked first, every file is hashed as it is copied, and the old
models are replaced only once every new file is in; an older pack never
replaces a newer one.

Signing: every Mach-O file (Electron helpers, the QVAC Bare worker, each
`.node` and `.bare` add-on) gets the hardened runtime and
`electron/entitlements.plist` (JIT, unsigned executable memory, library
validation off for the add-ons, microphone and camera for the coming UI).
Without a Developer ID certificate the app is signed ad hoc: it runs here
under the hardened runtime, but Gatekeeper refuses it elsewhere. A release
needs, on the vendor's machine:

1. A "Developer ID Application" certificate in the Keychain and
   `OFA_SIGN_IDENTITY="Developer ID Application: NAME (TEAMID)"`.
2. `xcrun notarytool store-credentials NAME` and `OFA_NOTARY_PROFILE=NAME`.
3. The vendor's release keys in `src/features/packs/trusted-keys.ts` and
   `src/features/platform/license-keys.ts`, in place of the development
   keys (labelled "not for release"; `package:release` refuses them).

The release gate: on a clean Mac with networking off, copy a kit (the zip,
the model pack as `models/`, a content pack, a license issued for that Mac's
`ofa license device-id`, and `tests/fixtures` as `fixtures/`) and run
`release-gate.sh KIT`. `npm run eval:packaging` builds such a kit in
`var/release-kit/` on the dev machine. Ad hoc builds are a new code identity
each time, so macOS asks before one reads the Keychain item another made:
on a dev Mac, run the gate with `--key-store keychain`.

## The window

Six sections, listed in a sidebar that is always shown (☰ switches it
between names and icons only) and reached with ⌘1–⌘6, each in light and
dark (System, Light or Dark in Settings › General):

1. **Conversation**: a column per person, each in their own language. Hold the
   button (Space for the clinician, Return for the patient) to talk; the
   translation is read aloud as soon as it exists. The clinician's column
   shows the back-translation check and every warning.
2. **Phrasebook**: phrases by category, searchable in both languages, played
   as recorded.
3. **Ask the guide**: a typed or spoken question; the best card opens with
   its danger signs first, or "no match" when none fits.
4. **Documents**: a photo, camera still or PDF, translated part by part beside
   the original, with unclear parts marked.
5. **Translate & read aloud**: typed text, translated with the check; either
   side read aloud.
6. **Settings**: appearance, licence, models, content packs, activity log, help.

Sections the licence does not cover say so and link to Settings › Licence.
The page is plain TypeScript (`electron/renderer/src/`), one stylesheet with
the colour tokens for both themes (`electron/renderer/styles.css`), and no
framework.

## Rules

- Only `src/core/qvac.ts` imports `@qvac/sdk`. Features depend on the interfaces in
  `src/core/engines.ts` (`Translator`, `Embedder`, …) and are unit-tested with fakes.
- At runtime, models load from local files listed in `models/manifest.json`
  (sha256-pinned). Registry, HTTP and P2P sources are refused.
- Install with `npm ci` only; the lockfile pins the SDK's add-on packages.
