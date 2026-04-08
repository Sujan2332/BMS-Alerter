#!/bin/bash
apt-get update
apt-get install -y chromium-browser
echo "Chromium installed at: $(which chromium-browser)"
chromium-browser --version
npm install