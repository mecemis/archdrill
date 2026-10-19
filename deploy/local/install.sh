#!/bin/bash
# Installs the LaunchAgent that keeps the production build running on
# 127.0.0.1:4173, for this checkout and this user, and starts it.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
label="com.mecemis.archdrill.web"
domain="gui/$(id -u)"
target="$HOME/Library/LaunchAgents/$label.plist"

# The paths go into a sed replacement, a single-quoted shell command and XML.
for path in "$repo" "$HOME"; do
  case "$path" in
    *[\'\#\&\<\>\\]*)
      echo "Cannot install from $path: move the checkout to a path without ' # & < > or \\." >&2
      exit 1
      ;;
  esac
done

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s#__REPO__#$repo#g" -e "s#__HOME__#$HOME#g" "$repo/deploy/local/$label.plist" > "$target"

# Replace a running copy: bootout returns before it has gone.
if launchctl print "$domain/$label" >/dev/null 2>&1; then
  launchctl bootout "$domain/$label" || true
  for _ in $(seq 1 20); do
    launchctl print "$domain/$label" >/dev/null 2>&1 || break
    sleep 0.5
  done
fi
launchctl bootstrap "$domain" "$target"
echo "Installed $target; the log is $HOME/Library/Logs/archdrill-web.log"
