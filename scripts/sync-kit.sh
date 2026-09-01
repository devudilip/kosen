#!/usr/bin/env bash
# pnpm sync-kit — vendor packages/tachi-kit from ../satusd verbatim.
#
# tachi-kit is authored in satusd and copied here as-is (docs/PLAN.md Phase 1,
# ../../SHARED-CONTEXT.md "The tachi-kit contract"). Never edit the local
# copy — if kosen needs a change, make it in satusd and re-run this script.
# A checksum file (packages/tachi-kit/.source-checksum) records the hash of
# the last successful sync, so a stale local copy that has drifted from the
# source fails loudly instead of silently diverging.
#
# KIT_SOURCE overrides the default source path — e.g. to point at satusd's
# in-progress worktree before it's merged to satusd's main branch
# (docs/DIRECTIVE-02.md, Task 1: "do not wait for satusd's commitment.ts").
# Default stays ../satusd/packages/tachi-kit so a plain `pnpm sync-kit` keeps
# working once satusd ships there.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KOSEN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="${KIT_SOURCE:-$KOSEN_ROOT/../satusd/packages/tachi-kit}"
DEST_DIR="$KOSEN_ROOT/packages/tachi-kit"
CHECKSUM_FILE="$DEST_DIR/.source-checksum"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "sync-kit: $SOURCE_DIR does not exist yet." >&2
  echo "satusd hasn't published packages/tachi-kit — nothing to vendor." >&2
  echo "Per docs/PLAN.md: build Phases 2, 5, 6 in the meantime; they need nothing from the kit." >&2
  exit 1
fi

if [ ! -f "$SOURCE_DIR/src/index.ts" ] && [ -z "$(ls -A "$SOURCE_DIR/src" 2>/dev/null)" ]; then
  echo "sync-kit: $SOURCE_DIR/src exists but looks empty — satusd's kit isn't ready yet." >&2
  exit 1
fi

echo "sync-kit: vendoring $SOURCE_DIR -> $DEST_DIR"

# Compute a checksum of the source tree's contents before copying, so we can
# both record it (for the next run's drift check) and detect a no-op sync.
compute_checksum() {
  find "$1" -type f -not -name '.source-checksum' -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}'
}

if [ -f "$CHECKSUM_FILE" ] && [ -d "$DEST_DIR/src" ]; then
  PREVIOUS_DEST_CHECKSUM=$(compute_checksum "$DEST_DIR/src" 2>/dev/null || echo "")
  RECORDED_CHECKSUM=$(cat "$CHECKSUM_FILE")
  if [ -n "$PREVIOUS_DEST_CHECKSUM" ] && [ "$PREVIOUS_DEST_CHECKSUM" != "$RECORDED_CHECKSUM" ]; then
    echo "sync-kit: FATAL — packages/tachi-kit has local edits that differ from the last synced" >&2
    echo "version. Do not edit the vendored copy directly — make the change in satusd instead" >&2
    echo "and re-run 'pnpm sync-kit'. Recorded checksum: $RECORDED_CHECKSUM, current: $PREVIOUS_DEST_CHECKSUM" >&2
    exit 1
  fi
fi

# Preserve package.json/tsconfig.json (kosen-local build config) but replace
# src/ entirely with the vendored source.
rm -rf "$DEST_DIR/src"
mkdir -p "$DEST_DIR/src"
cp -R "$SOURCE_DIR/src/." "$DEST_DIR/src/"

NEW_CHECKSUM=$(compute_checksum "$DEST_DIR/src")
echo "$NEW_CHECKSUM" > "$CHECKSUM_FILE"

echo "sync-kit: done. Vendored source checksum: $NEW_CHECKSUM"
echo "Run 'pnpm --filter @kosen/tachi-kit build' to compile the vendored copy."
