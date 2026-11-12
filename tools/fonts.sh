#!/bin/sh
# Prepara (una volta sola) un ambiente Python con fontTools e lancia fonts.py.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -x "$DIR/.venv/bin/python" ]; then
  python3 -m venv "$DIR/.venv"
  "$DIR/.venv/bin/pip" install -q --disable-pip-version-check fonttools brotli
fi
exec "$DIR/.venv/bin/python" -I "$DIR/fonts.py" "$@"
