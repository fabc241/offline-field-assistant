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
