#!/bin/sh
# End-to-end run against a throwaway headless Firefox profile (your own profile is never touched).
# Needs: the native host registered (node src/cli.mjs install --no-agents), Python 3 for the fixture server.
set -e
cd "$(dirname "$0")/../.."
printf 'hunter2-secret' | node src/cli.mjs secrets add testpw --origin http://127.0.0.1:8765 >/dev/null
python3 -m http.server 8765 --bind 127.0.0.1 --directory test/e2e/site >/dev/null 2>&1 &
SERVER=$!
npx --yes web-ext@8 run --source-dir extension --firefox="${FIREFOX:-/Applications/Firefox.app/Contents/MacOS/firefox}" \
  --no-reload --no-input --arg=-headless --start-url about:blank >/dev/null 2>&1 &
WEBEXT=$!
cleanup() {
  node src/cli.mjs secrets remove testpw >/dev/null 2>&1 || true
  kill $SERVER $WEBEXT 2>/dev/null || true
  pkill -f 'firefox -start-debugger-server [0-9]+ -foreground -no-remote -profile' 2>/dev/null || true
}
trap cleanup EXIT
node -e 'import("./src/client.mjs").then(async ({health}) => { for (let i = 0; i < 60; i++) { if ((await health())?.ok) return; await new Promise(r => setTimeout(r, 1000)); } process.exit(1); })'
for f in test/e2e/steps/steps[1-5].json; do
  echo "== $f"
  node test/e2e/run-steps.mjs "$f" "e2e-$(basename "$f" .json)" | grep -E '^=== ' || true
done
