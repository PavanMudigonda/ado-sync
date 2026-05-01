#!/bin/bash
set -eo pipefail

echo "Building site..."
# Copy root README.md to docs/index.md to be the welcome page
cp README.md docs/index.md
