#!/bin/bash
# Builds ArchDrill and serves the production build on 127.0.0.1:4173, for
# `tailscale serve` to publish to the tailnet. Run by the LaunchAgent in this
# folder; it serves whatever is checked out, so restart it after pulling.
set -euo pipefail
cd "$(dirname "$0")/../.."
echo "$(date '+%Y-%m-%d %H:%M:%S') building $(git rev-parse --short HEAD) on $(git branch --show-current)"
exec pnpm serve
