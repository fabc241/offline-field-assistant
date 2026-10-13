#!/usr/bin/env bash
# Runs a command and samples every socket opened by it and its child processes
# (including the QVAC Bare worker). Fails if any non-loopback socket appears.
#
#   scripts/net-audit.sh npm run ofa -- doctor --load
#   scripts/net-audit.sh "out/Offline Field Assistant-darwin-arm64/Offline Field Assistant.app/Contents/MacOS/offline-field-assistant"
set -uo pipefail

if [ $# -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

seen=$(mktemp)
trap 'rm -f "$seen"' EXIT

descendants() {
  local pid=$1
  echo "$pid"
  for child in $(pgrep -P "$pid"); do descendants "$child"; done
}

"$@" &
root=$!

while kill -0 "$root" 2>/dev/null; do
  pids=$(descendants "$root" | paste -sd, -)
  lsof -nP -i -a -p "$pids" 2>/dev/null | awk 'NR > 1 { print $1, $5, $8, $9 }' >> "$seen"
  sleep 0.5
done
wait "$root"
status=$?

sort -u "$seen" -o "$seen"
external=$(grep -vE '127\.0\.0\.1|\[::1\]|localhost' "$seen" || true)

echo
echo "── network audit ──"
echo "command exit status: $status"
if [ -s "$seen" ]; then
  echo "sockets seen (process type proto address):"
  sed 's/^/  /' "$seen"
else
  echo "no sockets opened"
fi

if [ -n "$external" ]; then
  echo "FAIL: non-loopback sockets were opened"
  exit 1
fi
echo "PASS: no non-loopback sockets"
exit "$status"
