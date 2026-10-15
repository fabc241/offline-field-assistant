# Sample content pack

**PLACEHOLDER – NOT CLINICALLY VETTED.** Every card and phrase here was written
for development and testing. The Swahili has not been checked by a native
speaker, and the guidance has not been reviewed by a clinician. Do not use it
with patients.

Build, sign and install it with:

```bash
npm run ofa -- pack build content/sample
npm run ofa -- pack sign --key keys/ofa-dev-2026.key.pem var/pack-builds/sample-intake-0.2.0.ofapack
npm run ofa -- pack install var/pack-builds/sample-intake-0.2.0.ofapack
```

Every recording in `recordings/` is a **synthetic placeholder**. Each was made
with Chatterbox's built-in voice (`npm run make-phrase-recordings`) and has a
`.synthetic.json` record next to it, so the pack tags it `synthetic`. Replace
each one with a native speaker's recording of the vetted phrase, then delete
its record.
