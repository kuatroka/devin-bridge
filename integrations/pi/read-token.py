#!/usr/bin/env python3
"""Print the existing Devin session token for Pi's provider resolver.

The token remains in Devin's credentials file; this helper only bridges it to
Pi's provider API-key resolver at request time.
"""
from pathlib import Path
import os
import sys
import tomllib

path = Path(os.environ.get("DEVIN_CREDENTIALS_FILE", "~/.local/share/devin/credentials.toml")).expanduser()
try:
    with path.open("rb") as file:
        token = tomllib.load(file).get("windsurf_api_key")
except (OSError, tomllib.TOMLDecodeError, TypeError):
    raise SystemExit(1)

if not isinstance(token, str) or not token.strip():
    raise SystemExit(1)
print(token.strip())
