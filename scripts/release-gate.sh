#!/bin/bash
# The F10 release gate. Needs nothing but macOS: run it on a clean Mac with
# networking disabled, from a kit copied over by USB.
#
#   release-gate.sh KIT [--home DIR] [--key-store safestorage|keychain] [--out DIR]
#
# KIT holds:
#   offline-field-assistant-*-arm64.zip   the packaged app (npm run package[:release])
#   models/                               the signed model pack (ofa models build + sign)
#   *.ofapack                             a signed content pack
#   *.ofalicense                          a license for this Mac (ofa license device-id here, issue on the vendor side)
#   fixtures/                             the IPC smoke fixtures (tests/fixtures)
#
# It installs the app from the zip into a scratch folder, then, through the
# app's own binary (no Node needed): installs the license, the model pack and
# the content pack, runs `ofa doctor --verify --load` and the IPC smoke suite.
# Every process the app starts (Electron helpers, the QVAC Bare worker) is
# watched with lsof the whole time; any non-loopback socket fails the gate.
#
# --home: where the app keeps its files (default: the real
#   ~/Library/Application Support/OfflineFieldAssistant, as on a clinic Mac).
# --key-store keychain: keep the log key in a scratch Keychain item, removed
#   at the end, instead of safeStorage. For ad hoc builds on a dev Mac, where
#   every rebuild is a new code identity that macOS would ask about.
set -uo pipefail

usage() { echo "usage: $0 KIT [--home DIR] [--key-store safestorage|keychain] [--out DIR]" >&2; exit 2; }
[ $# -ge 1 ] || usage
KIT=$(cd "$1" && pwd) || usage
shift
HOME_DIR=""
KEY_STORE=safestorage
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_DIR=$2; shift 2 ;;
    --key-store) KEY_STORE=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    *) usage ;;
  esac
done

now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
fail() { echo "✖ $*" >&2; exit 1; }

zip=$(ls "$KIT"/offline-field-assistant-*-arm64.zip 2>/dev/null | head -1)
pack=$(ls "$KIT"/*.ofapack 2>/dev/null | head -1)
license=$(ls "$KIT"/*.ofalicense 2>/dev/null | head -1)
[ -n "$zip" ] || fail "no offline-field-assistant-*-arm64.zip in $KIT"
[ -n "$pack" ] || fail "no .ofapack in $KIT"
[ -n "$license" ] || fail "no .ofalicense in $KIT"
[ -f "$KIT/models/manifest.json" ] || fail "no model pack in $KIT/models"
[ -d "$KIT/fixtures" ] || fail "no fixtures in $KIT"

WORK=$(mktemp -d /tmp/ofa-gate-XXXXXX)
OUT=${OUT:-$WORK/report}
mkdir -p "$OUT"
STEPS="$OUT/steps.tsv"
printf 'step\texit\tms\tsockets\n' > "$STEPS"

echo "Release gate: $(sw_vers -productName) $(sw_vers -productVersion), $(uname -m), $(sysctl -n hw.memsize | awk '{ printf "%.0f GB", $1 / 1073741824 }')"
echo "Kit: $KIT"

# Install: unzip as Finder would, keeping signatures and extended attributes.
t0=$(now_ms)
ditto -x -k "$zip" "$WORK/Applications" || fail "cannot unzip $zip"
APP="$WORK/Applications/Offline Field Assistant.app"
BIN="$APP/Contents/MacOS/offline-field-assistant"
printf 'install-app\t0\t%d\t0\n' $(( $(now_ms) - t0 )) >> "$STEPS"

if codesign --verify --deep --strict "$APP" 2>"$OUT/codesign.log"; then signature=valid; else signature=INVALID; fi
authority=$(codesign -dvv "$APP" 2>&1 | grep -m1 '^Authority=' | cut -d= -f2-)
[ -n "$authority" ] || authority="ad hoc"
gatekeeper=$(spctl --assess --type execute "$APP" 2>&1 && echo accepted || true)
gatekeeper=$(echo "$gatekeeper" | tail -1 | sed "s|$APP: ||")
echo "Signature: $signature ($authority); Gatekeeper: $gatekeeper"

if [ -n "$HOME_DIR" ]; then
  mkdir -p "$HOME_DIR"
  export OFA_HOME=$(cd "$HOME_DIR" && pwd)
else
  unset OFA_HOME
fi
unset OFA_MODELS_DIR OFA_PACKS_DIR OFA_LOG_DIR OFA_LICENSE OFA_LOG_TRANSCRIPTS
if [ "$KEY_STORE" = keychain ]; then
  export OFA_KEY_STORE=keychain OFA_KEYCHAIN_SERVICE="OFA release gate $$"
  trap '/usr/bin/security delete-generic-password -s "$OFA_KEYCHAIN_SERVICE" -a log-key >/dev/null 2>&1' EXIT
else
  unset OFA_KEY_STORE
fi

descendants() {
  local pid=$1
  echo "$pid"
  for child in $(pgrep -P "$pid"); do descendants "$child"; done
}

# Runs one step and samples the sockets of every process it starts.
audited() {
  local name=$1
  shift
  local seen="$OUT/$name.sockets"
  : > "$seen"
  local start
  start=$(now_ms)
  "$@" > "$OUT/$name.log" 2>&1 &
  local root=$!
  while kill -0 "$root" 2>/dev/null; do
    pids=$(descendants "$root" | paste -sd, -)
    lsof -nP -i -a -p "$pids" 2>/dev/null | awk 'NR > 1 { print $1, $5, $8, $9 }' >> "$seen"
    sleep 0.2
  done
  wait "$root"
  local status=$?
  local ms=$(( $(now_ms) - start ))
  sort -u "$seen" -o "$seen"
  local external
  external=$(grep -cvE '127\.0\.0\.1|\[::1\]|localhost' "$seen")
  printf '%s\t%d\t%d\t%d\n' "$name" "$status" "$ms" "$external" >> "$STEPS"
  printf '%s %-16s %6.1f s  sockets: %s\n' "$([ "$status" -eq 0 ] && [ "$external" -eq 0 ] && echo ✓ || echo ✗)" "$name" "$(echo "$ms / 1000" | bc -l)" "$external"
  grep -v '^\[' "$OUT/$name.log" | tail -3 | sed 's/^/      /'
}

audited license-install "$BIN" ofa license install "$license"
audited models-install "$BIN" ofa models install "$KIT/models"
audited pack-install "$BIN" ofa pack install "$pack"
audited doctor "$BIN" ofa doctor --verify --load
audited ipc-smoke "$BIN" --ipc-smoke --fixtures "$KIT/fixtures" --require-model-pack --out "$OUT/smoke.json"

failed=$(awk -F'\t' 'NR > 1 && ($2 != 0 || $4 != 0)' "$STEPS" | wc -l | tr -d ' ')
{
  echo "signature=$signature"
  echo "authority=$authority"
  echo "gatekeeper=$gatekeeper"
  echo "home=${OFA_HOME:-$HOME/Library/Application Support/OfflineFieldAssistant}"
  echo "keyStore=$KEY_STORE"
  echo "failedSteps=$failed"
} > "$OUT/gate.env"
echo
echo "Report: $OUT"
if [ "$signature" != valid ] || [ "$failed" -ne 0 ]; then
  echo "FAIL: release gate"
  exit 1
fi
echo "PASS: release gate (no non-loopback socket in any step)"
