#!/bin/bash
set -uo pipefail
APP=~/aes67-deck
DEPLOY=~/deploy
say() { printf '\n=== %s ===\n' "$*"; }

say "0. activate pipewire-jack system-wide (PipeWire provides libjack)"
sudo cp /usr/share/doc/pipewire/examples/ld.so.conf.d/pipewire-jack-x86_64-linux-gnu.conf /etc/ld.so.conf.d/
sudo ldconfig
ldconfig -p | grep "libjack.so.0"

say "1. engine (cmake, native -march for this box)"
cd "$APP/engine"
rm -rf build
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release >/dev/null 2>&1
cmake --build build -j"$(nproc)" 2>&1 | tail -6
test -x build/aes67_deck_engine && echo "ENGINE OK" || { echo "ENGINE BUILD FAILED"; exit 1; }
echo "--- linked libjack ---"; ldd build/aes67_deck_engine | grep -iE "jack|pipewire"

say "2. server (npm install + tsc build)"
cd "$APP/server"
npm install --no-audit --no-fund 2>&1 | tail -4
npm run build 2>&1 | tail -6
test -f dist/index.js && echo "SERVER OK" || { echo "SERVER BUILD FAILED"; exit 1; }

say "3. runtime dirs + UI files"
mkdir -p "$APP/scenes" "$APP/rack_presets"
sudo install -d /var/www/aes67-deck
sudo rsync -a --delete /tmp/ui-dist/ /var/www/aes67-deck/
sudo chown -R www-data:www-data /var/www/aes67-deck

say "4. systemd user services"
mkdir -p ~/.config/systemd/user
install -m 0644 "$DEPLOY/systemd/aes67-deck-server.service" ~/.config/systemd/user/
install -m 0644 "$DEPLOY/systemd/aes67-deck-engine.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable aes67-deck-server.service aes67-deck-engine.service

say "5. nginx UI site"
sudo cp "$DEPLOY/nginx/aes67-deck" /etc/nginx/sites-available/aes67-deck
sudo ln -sf /etc/nginx/sites-available/aes67-deck /etc/nginx/sites-enabled/aes67-deck
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t 2>&1 | tail -2
sudo systemctl reload nginx

echo; echo "DECK BUILD DONE."
