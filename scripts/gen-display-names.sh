#!/usr/bin/env bash
#
# Print a COURSE_DISPLAY_NAMES value covering every Andamio course, as a
# scaffold to CURATE down to the courses your server cares about.
#
# Requires the Andamio CLI (authenticated) and python3. The bot does NOT use
# this at runtime; it is a one-off setup convenience. See docs/BUILDER-GUIDE.md.
#
# Usage:
#   ./scripts/gen-display-names.sh
# then trim the output to the relevant courses and set it as COURSE_DISPLAY_NAMES.

set -euo pipefail

if ! command -v andamio >/dev/null 2>&1; then
  echo "error: the 'andamio' CLI is not installed or not on PATH." >&2
  echo "See https://github.com/Andamio-Platform/andamio-cli" >&2
  exit 1
fi

andamio course list --output json | python3 -c '
import sys, json
courses = json.load(sys.stdin)
m = {}
for c in courses:
    cid = c.get("course_id")
    title = (c.get("content") or {}).get("title")
    if cid and title:
        m[cid] = " ".join(title.split())
print(json.dumps(m, separators=(",", ":"), ensure_ascii=False))
'
