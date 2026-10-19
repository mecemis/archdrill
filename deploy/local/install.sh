#!/bin/bash
# Installs the LaunchAgent that keeps the production build running on
# 127.0.0.1:4173, for this checkout and this user, and starts it.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
label="com.mecemis.archdrill.web"
target="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s#__REPO__#$repo#g" -e "s#__HOME__#$HOME#g" "$repo/deploy/local/$label.plist" > "$target"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$target"
echo "Installed $target; the log is $HOME/Library/Logs/archdrill-web.log"
