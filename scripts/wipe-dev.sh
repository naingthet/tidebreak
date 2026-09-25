#!/usr/bin/env bash
#
# Wipe the dev build's local state so the next `scripts/dev.sh` run starts
# from a fresh profile.
#
# Dev builds keep every store separate from an installed release: the debug
# identifier override keys the app-data dir (`io.github.naingthet.tidebreak.dev`),
# secrets live under the keychain service of the same name, and on macOS the
# unbundled debug binary's WebView data lands under its process name
# (`tidebreak-desktop`) rather than a bundle identifier. Dev builds from before
# the identity changed (decision 103) used `io.brightwave.tidebreak.dev` and
# the `tidebreak.dev` keychain service, and a dev build moves those into the
# current ones at launch, so they go too: otherwise the next run would move
# the old profile back in. This deletes exactly those dev stores and never
# touches the release profile.
#
#   scripts/wipe-dev.sh        # list what would be deleted and ask first
#   scripts/wipe-dev.sh --yes  # no prompt

set -euo pipefail

assume_yes=false
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && assume_yes=true

dev_id="io.github.naingthet.tidebreak.dev"
previous_dev_id="io.brightwave.tidebreak.dev"
dev_keychain_services=("$dev_id" "tidebreak.dev")
# The unbundled debug binary's name, which keys its WebView storage on macOS.
dev_process="tidebreak-desktop"

if pgrep -x "$dev_process" >/dev/null 2>&1; then
  echo "A dev build ($dev_process) is running; quit it first." >&2
  exit 1
fi

case "$(uname -s)" in
Darwin)
  support="$HOME/Library/Application Support"
  targets=(
    "$support/$dev_id"
    "$support/$dev_id.move.json"
    "$support/$dev_id.move.lock"
    "$support/$dev_id.moving"
    "$support/$previous_dev_id"
    "$HOME/Library/Caches/$dev_id"
    "$HOME/Library/Caches/$previous_dev_id"
    "$HOME/Library/WebKit/$dev_id"
    "$HOME/Library/WebKit/$previous_dev_id"
    "$HOME/Library/Caches/$dev_process"
    "$HOME/Library/WebKit/$dev_process"
    "$HOME/Library/HTTPStorages/$dev_process"
    "$HOME/Library/Preferences/$dev_process.plist"
    "$HOME/Library/Saved Application State/$dev_process.savedState"
  )
  ;;
Linux)
  data="${XDG_DATA_HOME:-$HOME/.local/share}"
  targets=(
    "$data/$dev_id"
    "$data/$dev_id.move.json"
    "$data/$dev_id.move.lock"
    "$data/$dev_id.moving"
    "$data/$previous_dev_id"
    "${XDG_CONFIG_HOME:-$HOME/.config}/$dev_id"
    "${XDG_CONFIG_HOME:-$HOME/.config}/$previous_dev_id"
    "${XDG_CACHE_HOME:-$HOME/.cache}/$dev_id"
    "${XDG_CACHE_HOME:-$HOME/.cache}/$previous_dev_id"
  )
  ;;
*)
  echo "Unsupported platform: $(uname -s)" >&2
  exit 1
  ;;
esac

existing=()
for target in "${targets[@]}"; do
  [[ -e "$target" ]] && existing+=("$target")
done

if ((${#existing[@]} == 0)); then
  echo "No dev-profile files found."
else
  echo "Will delete:"
  printf '  %s\n' "${existing[@]}"
fi
for service in "${dev_keychain_services[@]}"; do
  echo "Will also remove every '$service' secret-store entry."
done

if ! $assume_yes; then
  read -r -p "Proceed? [y/N] " reply
  [[ "$reply" == y || "$reply" == Y ]] || {
    echo "Aborted."
    exit 1
  }
fi

# macOS ships bash 3.2, where expanding an empty array trips `set -u`.
for target in ${existing[@]+"${existing[@]}"}; do
  rm -rf "$target"
done

case "$(uname -s)" in
Darwin)
  deleted=0
  for service in "${dev_keychain_services[@]}"; do
    while security delete-generic-password -s "$service" >/dev/null 2>&1; do
      deleted=$((deleted + 1))
    done
  done
  echo "Removed $deleted keychain item(s)."
  # Drop the cached preferences domain along with the plist deleted above.
  defaults delete "$dev_process" >/dev/null 2>&1 || true
  ;;
Linux)
  # The keyring crate stores Secret Service entries with a `service`
  # attribute; `secret-tool clear` deletes every match.
  for service in "${dev_keychain_services[@]}"; do
    if command -v secret-tool >/dev/null 2>&1; then
      secret-tool clear service "$service" || true
      echo "Cleared '$service' Secret Service entries."
    else
      echo "secret-tool not found; remove '$service' entries" \
        "with your secret manager." >&2
    fi
  done
  ;;
esac

echo "Dev profile wiped."
