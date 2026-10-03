#!/bin/zsh
# Installs pocket-bridge as a LaunchAgent: starts at login and restarts if it crashes.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST=~/Library/LaunchAgents/com.pocket-bridge.server.plist
mkdir -p ~/Library/LaunchAgents "$DIR/logs"
NODE="$(command -v node)"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.pocket-bridge.server</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/logs/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/server.log</string>
</dict></plist>
PL
launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
echo "Zainstalowano. Logi: $DIR/logs/server.log"
echo "Odinstalowanie: launchctl bootout gui/\$(id -u) $PLIST && rm $PLIST"
