# Migration plan: Devin bridge out of the Pi agent extension

## Goal

Give the Devin bridge its own repository and GitHub home, with no code living
under `~/.pi/agent/extensions/`, while every external contract stays identical.

## Invariants (must not change)

| Contract | Value |
| -------- | ----- |
| Listen address | `127.0.0.1:20130` |
| OpenAI endpoints | `GET /v1/models`, `POST /v1/chat/completions` |
| Model IDs | `dv/claude-fable-5-1-*`, `dv/claude-haiku-5-5-*`, `dv/haiku-5-5-*`, `dv/swe-2-*`, `dv/deepseek-v4.1-flash*` |
| Devin credentials | `~/.local/share/devin/credentials.toml` |
| Devin API base | `https://server.codeium.com` |
| 9router provider node | openai-compatible, prefix `dv`, base URL `http://127.0.0.1:20130/v1` |
| launchd label | `com.local.devin.droid-bridge` |
| Log file | `/tmp/devin-droid-bridge.log` |

## Source inventory

Moved:

- `droid-bridge.ts` — HTTP server and model routing
- `provider.ts` — Devin Connect/protobuf streaming client
- `devin-proto.ts` — protobuf message definitions
- `protobuf.ts` — protobuf codec
- `index.ts` — Pi extension registration (kept as an optional integration)
- `read-token.py` — token helper used by the Pi integration

Not moved: `__pycache__/`, dated `.backup-*` copies, `devin-proto.ts` is kept
because `provider.ts` imports it.

## Code changes required by the move

1. `droid-bridge.ts`: import `./provider.ts` instead of the absolute extension path.
2. `provider.ts`: import `@earendil-works/pi-ai` as a package instead of the
   absolute global `node_modules` path.
3. `integrations/pi/index.ts`: resolve `provider` and `read-token.py` relative to
   the repository.
4. Add `package.json` (pinned `@earendil-works/pi-ai@1.3.0`), `tsconfig.json`,
   a `bin/devin-bridge` shim, and a launchd plist template.

No protocol, model, or routing logic changes.

## Cutover

1. Create `~/Documents/dev/devin-bridge` with the files above.
2. `bun install` and typecheck.
3. Point `~/Library/LaunchAgents/com.local.devin.droid-bridge.plist` at the new
   `src/droid-bridge.ts` and working directory.
4. `launchctl bootout` + `bootstrap` the service.
5. Verify: models list on `:20130`, models list through 9router on `:20128`,
   a chat completion for each model family, and Amp's `check-access` for the
   four panel models.
6. Archive the old `~/.pi/agent/extensions/devin-fable` directory outside the
   extensions tree.
7. `git init`, commit, create the GitHub repository, push.

## Rollback

Restore the archived extension directory, point the launchd plist back at
`~/.pi/agent/extensions/devin-fable/droid-bridge.ts`, and reload the service.

## Verification checklist

- [ ] `curl -s 127.0.0.1:20130/v1/models` lists all model IDs.
- [ ] `curl -s 127.0.0.1:20128/v1/models` lists the `dv/*` models.
- [ ] Chat completion succeeds for Fable, Haiku, SWE-2, and DeepSeek.
- [ ] `amp config model-providers check-access` routes `devin/haiku-5-5-max`,
      `devin/deepseek-v4.1-flash-max`, `devin/swe-2-max`, and
      `cx/gpt-6-luna-max` through 9Router.
- [ ] launchd keeps the service alive after a restart.
