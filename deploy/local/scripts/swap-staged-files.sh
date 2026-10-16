#!/bin/sh
# Step 4 of restore.sh, run inside the storage container (busybox sh):
#   sh -s -- /var/lib/storage < swap-staged-files.sh
# Moves the live files into .restore-old, the backup's files from .restore-staging into place,
# then deletes both directories, checking every single move first.
#
# Not `find … -exec mv {} \;`: in find (busybox, as in this image, and GNU alike) a failing
# `-exec … \;` only makes that expression false; find itself still exits 0. A failed move would
# go unnoticed and the cleanup would delete files. Here any failed move stops the swap with both
# directories kept, so nothing is lost, and exits 1; re-running restore.sh redoes it.
set -u
root="${1:?usage: swap-staged-files.sh <storage root>}"
cd "$root" || exit 1
[ -d .restore-staging ] || { echo "swap: no .restore-staging in $root" >&2; exit 1; }

# Left by an earlier failed swap that a re-run is now redoing: the backup supersedes those files.
rm -rf .restore-old && mkdir .restore-old || exit 1

stop() {
  echo "swap: could not move $1. Nothing was deleted: the previous files are in $root/.restore-old," >&2
  echo "swap: the backup's in $root/.restore-staging, and whatever was not moved is still in $root." >&2
  exit 1
}

# Every entry, dotfiles included; an unmatched pattern stays literal and fails the -e test.
for e in * .[!.]* ..?*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  case "$e" in .restore-old|.restore-staging) continue ;; esac
  mv "$e" .restore-old/ || stop "$root/$e out of the way"
done
for e in .restore-staging/* .restore-staging/.[!.]* .restore-staging/..?*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  mv "$e" . || stop "$root/$e into place"
done

rm -rf .restore-old .restore-staging
