#!/bin/zsh
# Exposes the local webhook server to the internet so Pocket's cloud can reach your Mac.
# Quick (temporary URL, changes on every start):   ./scripts/tunnel.sh
# Stable URL: create a named Cloudflare tunnel, see README.
set -e
cd "$(dirname "$0")/.."
PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-8787}
command -v cloudflared >/dev/null || brew install cloudflared
echo "Webhook URL dla Pocket = <adres https z poniższego logu>$(grep -E '^WEBHOOK_PATH=' .env | cut -d= -f2)"
exec cloudflared tunnel --url "http://127.0.0.1:$PORT"
