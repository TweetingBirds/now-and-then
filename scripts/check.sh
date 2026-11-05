#!/usr/bin/env bash
# Fast checks run on every pull request and before each deploy.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Syntax check"
for f in app/*.js worker/*.js; do node --check "$f"; done
node --input-type=module --check < worker/worker.js

echo "Worker tests"
(cd worker && node --test test/worker.test.mjs)

echo "Version matches What's New"
version="$(sed -n 's/.*const APP_VERSION = "\([^"]*\)".*/\1/p' app/app.js)"
latest="$(grep -o '<h2>[0-9][0-9.]* [^<]*<time[^>]*>[^<]*</time> <span class="tag">Latest</span>' app/whats-new.html | sed 's/<h2>\([0-9.]*\).*/\1/')"
case "$version" in
  "$latest" | "$latest".*) echo "APP_VERSION $version, What's New $latest" ;;
  *) echo "APP_VERSION is $version but the Latest card in whats-new.html is ${latest:-missing}"; exit 1 ;;
esac
