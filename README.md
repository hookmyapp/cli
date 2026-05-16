# @gethookmyapp/cli

HookMyApp CLI, No BS. Just go live.

## Install

```bash
npm install -g @gethookmyapp/cli
```

Requires Node.js >= 18.

## Quick Start

```bash
hookmyapp --help
hookmyapp --version
```

Run the interactive setup to connect your WhatsApp Business account and start
receiving webhooks:

```bash
hookmyapp login
hookmyapp channels connect
```

## Listening for webhooks on localhost

Two flavors — pick based on which kind of WhatsApp number you have.

**Sandbox** — a shared WABA managed by HookMyApp, for dev and testing:

```bash
hookmyapp sandbox listen --phone +<your-phone> --port 3000
```

**Real channel** — your own onboarded WABA, no customer-owned HTTPS URL
required. The CLI provisions a per-channel Cloudflare Tunnel and pipes
inbound webhooks straight to localhost:

```bash
hookmyapp channels listen --channel ch_XXXXXXXX --port 3000
```

While the CLI is running, the channel's dashboard destination shows as
**HookMyAppCLI**. Press Ctrl-C to stop — the destination returns to its
default. Real-channel tunnels can stay up indefinitely (24/7 use is
supported and expected, e.g. for local self-hosted AI agents).

If you set a webhook URL in the dashboard while the CLI is mid-listen,
the URL wins — the CLI exits cleanly on its next heartbeat with a notice.

## Identifiers

Starting with v0.5.0, every id flag takes a Stripe-style publicId instead of
a raw UUID. Prefixes:

| prefix | entity             | example        |
| ------ | ------------------ | -------------- |
| `ws_`  | workspace          | `ws_A4zq8d2T`  |
| `ch_`  | channel            | `ch_a4Zq8d2T`  |
| `ssn_` | sandbox session    | `ssn_3Bq8RkP2` |
| `inv_` | workspace invite   | `inv_7HjKp2Qe` |

Find yours with `hookmyapp workspace list` / `hookmyapp channels list` /
`hookmyapp sandbox status`. Pass as a flag:

```bash
hookmyapp --workspace ws_A4zq8d2T channels list
hookmyapp sandbox listen --session ssn_3Bq8RkP2
```

Raw UUID input (from pre-0.5.0 scripts) is rejected with a typed error —
upgrade your automation to the publicId shape.

## Telemetry

Starting with v0.8.0, HookMyApp CLI reports crashes to our Sentry project so
we can fix bugs fast. **No command arguments, file contents, or environment
variable values are sent** — only the error class, stack trace, CLI version,
platform, and (when you're logged in) your WorkOS user id.

Telemetry is ON by default — industry norm for product CLIs (npm, Next.js,
Vercel, Homebrew). You can disable it any time:

```bash
# Persistent (writes to ~/.hookmyapp/config.json):
hookmyapp config set telemetry off

# Session-scoped (overrides persisted setting for one invocation):
HOOKMYAPP_TELEMETRY=off hookmyapp <command>
```

Check the active state:

```bash
hookmyapp config show           # human
hookmyapp config show --json    # machine-readable
hookmyapp config get telemetry  # just the persisted flag
```

A one-time disclosure banner prints to stderr on your first authenticated
command. The decision is stored in `~/.hookmyapp/config.json` alongside your
active workspace + environment profile.

Re-enable later with `hookmyapp config set telemetry on` or revert to the
default with `hookmyapp config unset telemetry`.

## Documentation

Full docs: https://hookmyapp.com

## Issues

https://github.com/hookmyapp/hookmyapp/issues

## License

MIT
