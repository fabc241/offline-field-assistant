# Sample content pack

**PLACEHOLDER – NOT CLINICALLY VETTED.** Every card and phrase here was written
for development and testing. The Swahili has not been checked by a native
speaker, and the guidance has not been reviewed by a clinician. Do not use it
with patients.

Build, sign and install it with:

```bash
npm run ofa -- pack build content/sample
npm run ofa -- pack sign --key keys/ofa-dev-2026.key.pem var/pack-builds/sample-intake-0.1.0.ofapack
npm run ofa -- pack install var/pack-builds/sample-intake-0.1.0.ofapack
```

Phrase recordings (`audio_en`, `audio_sw`) are empty for now; F6 adds placeholder
recordings.
