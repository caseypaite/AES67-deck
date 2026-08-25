#!/bin/bash
set -e
echo "Installing dependencies for AES67-Deck on Arch Linux..."
if command -v apt-get > /dev/null; then
    echo "Using apt-get (Debian/Ubuntu)..."
    sudo apt-get update
    sudo apt-get install -y build-essential cmake pkg-config \
        liblilv-dev lilv-utils lsp-plugins calf-plugins \
        libjack-jackd2-dev libsndfile1-dev libsamplerate0-dev \
        libasound2-dev libuv1-dev \
        nodejs npm
elif command -v pacman > /dev/null; then
    echo "Using pacman (Arch Linux)..."
    sudo pacman -Syu --needed \
        base-devel cmake pkgconf \
        lilv lsp-plugins calf \
        pipewire-jack \
        libsndfile libsamplerate \
        alsa-lib libuv \
        nodejs npm cage
else
    echo "Unsupported package manager. Please install dependencies manually."
    exit 1
fi
echo "Dependencies installed successfully."
