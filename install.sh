#!/usr/bin/env sh
# One-click installer for dsh-auto-scheduler.
# Usage: ./install.sh [profile]   (default profile: web)
set -e
PROFILE="${1:-web}"
command -v dsh >/dev/null 2>&1 || { echo "[ERROR] dsh CLI not found in PATH. Install DeepSeek Harness first."; exit 1; }
echo "[1/2] Installing dsh-auto-scheduler into profile \"$PROFILE\" ..."
dsh plugin --profile "$PROFILE" add github:Cheng-xiu/dsh-auto-scheduler#v0.1.2
echo "[2/2] Done. Restart dsh web to activate (sidebar entry: Auto Work)."
