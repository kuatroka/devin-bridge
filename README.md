# devin-bridge

A local, OpenAI-compatible HTTP bridge to the Devin (Cognition) agent API. It
lets any OpenAI Chat Completions client use Devin-hosted models by exposing
`GET /v1/models` and `POST /v1/chat/completions` on `127.0.0.1:20130`.

The bridge reads the existing Devin CLI credentials and speaks Devin's
Connect/protobuf protocol directly; it does not shell out to the `devin` CLI.

## Endpoints

| Method | Path                 | Purpose                          |
| ------ | -------------------- | -------------------------------- |
| GET    | `/v1/models`         | List the models this bridge serves |
| POST   | `/v1/chat/completions` | Chat Completions (streaming or `stream: false`) |

## Models

| Family | IDs | Upstream |
| ------ | --- | -------- |
| Fable 5.1 | `claude-fable-5-1-{low,medium,high,xhigh,max}` | `claude-fable-5-1-*` |
| Haiku 5.5 | `claude-haiku-5-5-{low,medium,high,xhigh,max}` | `claude-haiku-5-5-*` |
| Haiku 5.5 alias | `haiku-5-5-{low,medium,high,xhigh,max}` | same upstream as above |
| SWE-2 | `swe-2-{medium,high,max}` | `swe-2-*` |
| DeepSeek V4.1 Flash | `deepseek-v4.1-flash`, `-none`, `-high`, `-max` | `deepseek-v4-1-flash-1017-*` |

The `haiku-5-5-*` aliases exist because some clients (Amp) refuse to route
Claude-named model IDs through a custom OpenAI-compatible endpoint. They select
the same upstream Haiku 5.5 model as the `claude-haiku-5-5-*` IDs.

## Configuration

| Setting | Default | Where |
| ------- | ------- | ----- |
| Listen host/port | `127.0.0.1:20130` | `src/droid-bridge.ts` |
| Devin credentials | `~/.local/share/devin/credentials.toml` | `CREDENTIALS_PATH` |
| Devin API base | `https://server.codeium.com` | `DEVIN_BASE_URL` |

The credentials file must contain `windsurf_api_key`. Run `devin auth login`
if it is missing or expired.

## Run

```sh
bun install
bun run start
```

Or install the CLI shim:

```sh
bun link
devin-bridge
```

## Run as a macOS service

`launchd/com.local.devin.droid-bridge.plist` runs the bridge at login and
restarts it if it exits. Copy it to `~/Library/LaunchAgents/` and load it:

```sh
cp launchd/com.local.devin.droid-bridge.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.devin.droid-bridge.plist
launchctl kickstart -k gui/$(id -u)/com.local.devin.droid-bridge
```

Logs go to `/tmp/devin-droid-bridge.log`.

## Verify

```sh
curl -s http://127.0.0.1:20130/v1/models | jq -r '.data[].id'
curl -s http://127.0.0.1:20130/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"dv/haiku-5-5-max","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

## Layout

```
src/droid-bridge.ts   HTTP server, request/response mapping
src/provider.ts       Devin Connect/protobuf streaming client
src/devin-proto.ts    Devin protobuf message definitions
src/protobuf.ts       Minimal protobuf codec
integrations/pi/      Optional Pi agent extension that registers the provider
launchd/              macOS launchd service definition
```

## Pi integration (optional)

`integrations/pi/index.ts` registers the Devin provider inside the Pi agent.
It is kept here for reference; the bridge itself does not depend on Pi beyond
the published `@earendil-works/pi-ai` types and event-stream helper.
