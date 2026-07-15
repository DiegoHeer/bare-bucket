#!/usr/bin/env bash
# Seeds the local MinIO bucket with a realistic tree for browse-UI testing.
# Usage: scripts/seed-demo.sh   (MinIO + createbucket must have run)
set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

make_file() { # path bytes
  mkdir -p "$tmp/$(dirname "$1")"
  head -c "$2" /dev/urandom > "$tmp/$1"
}

make_file "photos/2026/trip/IMG_0142.jpg" 180000
make_file "photos/2026/trip/IMG_0143.jpg" 210000
make_file "photos/2026/other.png"          90000
make_file "photos/2025/archive.jpg"       120000
make_file "docs/itinerary.pdf"             48000
make_file "docs/notes.txt"                  2000
make_file "videos/clip.mp4"               900000
make_file "readme.md"                       1200

docker run --rm --network host -v "$tmp":/seed:z --entrypoint sh minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727 -c '
  mc alias set local http://127.0.0.1:9000 baretest baretest123 &&
  mc cp --recursive /seed/ local/bare-bucket-it/
'
echo "Seeded. Open the app and hit Refresh (or reconnect) to rebuild the manifest."
