#!/usr/bin/env bash
# One fresh, unattended Claude Code session per screen, in dependency order (fidelity/screens.txt).
# Start the app first and export APP_URL. Run two or three screens before the rest.
# The proof plugin's Stop gate runs the fidelity check for fidelity/.current-screen whenever a session tries to finish.
# Add your build, lint and test commands to --allowedTools.
set -u; cd "$(git rev-parse --show-toplevel)" || exit 1
f=fidelity; trap 'rm -f fidelity/.current-screen' EXIT
curl -sf -o /dev/null "${APP_URL:-http://localhost:8081}" || { echo "Start the app first (APP_URL)"; exit 1; }
while read -r s; do
  [ -n "$s" ] || continue
  echo "$s" > $f/.current-screen
  claude -p "/goal Screen $s matches $f/inventory/$s.json, built from the mockup frame it names, using only theme tokens and shared components; $f/verify-screen.sh $s prints ALL PASS in the transcript; the proof:screen-judge agent then reports FAILS: 0; and the screen is committed. Or stop after 15 turns." \
    --permission-mode dontAsk --allowedTools "Edit,Write,Agent,Bash($f/verify-screen.sh *),Bash(git add *),Bash(git commit *),Bash(git checkout contract -- *)" < /dev/null
done < $f/screens.txt
