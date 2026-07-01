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

Run the interactive setup to connect a WhatsApp Business or Instagram account
and start receiving webhooks:

```bash
hookmyapp login
hookmyapp channels connect              # interactive: pick WhatsApp or Instagram
hookmyapp channels connect whatsapp     # or name the type directly
hookmyapp channels connect instagram
```

## Authentication

`hookmyapp login` signs you in through your browser and is the default for
interactive use.

**Browser-free sign-in** (for headless environments and AI agents) uses an
emailed one-time code instead of a browser:

```bash
# Interactive terminal: prompts you for the 6-digit code from your email
hookmyapp login --email you@example.com

# Non-interactive / agent: two steps, because the code arrives out of band
hookmyapp login --email you@example.com --json
# -> { "registrationId": "...", "expiresAt": "..." }
hookmyapp login --email you@example.com --registration-id <id> --otp 123456 --json
```

This stores an organization-scoped credential (`ac_…`). Pass `--scope <name>`
(repeatable) to request a narrower set than the default full access.

Manage those credentials:

```bash
hookmyapp credentials list
hookmyapp credentials revoke ac_ab12cd34 -y
```

## Listening for webhooks on localhost

Two flavors — pick based on which channel you have.

**Sandbox** — a shared sandbox managed by HookMyApp, for dev and testing. Supports WhatsApp and Instagram:

```bash
# WhatsApp: bind a session, get env vars, listen
hookmyapp sandbox start --type=whatsapp
hookmyapp sandbox env --phone +<your-phone> --write .env
hookmyapp sandbox listen --phone +<your-phone> --port 3000

# Instagram: bind a session, get env vars, listen
hookmyapp sandbox start --type=instagram
hookmyapp sandbox env --username @<your-handle> --write .env
hookmyapp sandbox listen --username @<your-handle> --port 3000
```

**Real channel**: your own onboarded WhatsApp or Instagram channel, no
customer-owned HTTPS URL required. The CLI provisions a per-channel Cloudflare
Tunnel and pipes inbound webhooks straight to localhost. The channel argument
is a positional and accepts a channel ID, a phone, or an Instagram handle.
Omit it to get an interactive picker:

```bash
hookmyapp channels listen ch_XXXXXXXX --port 3000
hookmyapp channels listen +15551234567 --port 3000
hookmyapp channels listen @your-handle --port 3000
hookmyapp channels listen --port 3000              # interactive picker
```

While the CLI is running, the channel's dashboard destination shows as
**HookMyAppCLI**. Press Ctrl-C to stop — the destination returns to its
default. Real-channel tunnels can stay up indefinitely (24/7 use is
supported and expected, e.g. for local self-hosted AI agents).

If you set a webhook URL in the dashboard while the CLI is mid-listen,
the URL wins — the CLI exits cleanly on its next heartbeat with a notice.

## Identifiers

Every id flag takes a Stripe-style publicId. Prefixes:

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

Raw UUID input is rejected with a typed error. Use the publicId shape in your
automation.

Every `<channel>` argument is shape-detected and accepts any of three forms:
a HookMyApp Channel ID (`ch_xxxxxxxx`), a phone in `+E164` form (WhatsApp
channels), or an Instagram handle as `@handle` (Instagram channels). It never
takes a Meta WABA ID. Run `hookmyapp channels list` to see your channel IDs,
phones, and handles.

## Channel commands

All channel-scoped operations live under `hookmyapp channels`. Every
`<channel>` argument accepts a channel ID (`ch_xxxxxxxx`), a `+phone`
(WhatsApp), or an `@handle` (Instagram):

```bash
hookmyapp channels connect [whatsapp|instagram]   # Meta OAuth (interactive if no type)
hookmyapp channels list                            # all channels (WhatsApp + Instagram)
hookmyapp channels show ch_xxxxxxxx
hookmyapp channels show @your-handle               # Instagram channel by handle
hookmyapp channels env ch_xxxxxxxx --write .env
hookmyapp channels token ch_xxxxxxxx
hookmyapp channels health ch_xxxxxxxx
hookmyapp channels enable ch_xxxxxxxx              # turn forwarding on
hookmyapp channels disable ch_xxxxxxxx             # turn forwarding off
hookmyapp channels disconnect ch_xxxxxxxx
hookmyapp channels webhook show ch_xxxxxxxx
hookmyapp channels webhook set ch_xxxxxxxx --url https://example.com/webhook
hookmyapp channels webhook clear ch_xxxxxxxx       # revert to the HookMyApp CLI tunnel
hookmyapp channels logs list ch_xxxxxxxx
hookmyapp channels logs show <delivery-id>
```

Add `--json` to any of these for machine-readable output (see the JSON
output section below). The `listen` subcommand is covered in
"Listening for webhooks on localhost" above.

### Env values written by `channels env`

`channels env <channel>` emits the credentials for a real connected channel.
The key names differ by channel type:

WhatsApp channel:

```bash
META_GRAPH_API_URL=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_WABA_ID=...
HOOKMYAPP_CHANNEL_ID=ch_xxxxxxxx
VERIFY_TOKEN=...
```

Instagram channel:

```bash
INSTAGRAM_GRAPH_API_URL=...
INSTAGRAM_ACCESS_TOKEN=...
INSTAGRAM_USER_ID=...
HOOKMYAPP_CHANNEL_ID=ch_xxxxxxxx
VERIFY_TOKEN=...
```

These are the real-channel key names. The sandbox emits a different shape
(see "Sandbox env values" under the sandbox section). A `channels env` block
has no `PORT` line; the sandbox block does.

## JSON output and global flags

Four global flags apply to every command:

| flag                 | effect                                                      |
| -------------------- | ----------------------------------------------------------- |
| `--json`             | Machine-readable JSON output (silences colors and spinners) |
| `--human`            | Force human-readable output (the default)                   |
| `--workspace <slug>` | Run in a specific workspace (name, slug, or id)             |
| `--debug`            | Print full request/response and stack traces                |

In `--json` mode, success output is a JSON document on stdout and errors are a
single envelope on stderr:

```json
{"error":{"code":"CHANNEL_NOT_FOUND","message":"No channel matches @nope","status":404}}
```

The `code` is a stable machine-readable string, `message` is human text, and
`status` is the HTTP-style status. Some errors add an optional `hint` or
`details` field.

Credentials are stored as a plain local file at `credentials.json` in the CLI
config directory, readable and writable only by you (`0600`). This matches how
`gh`, `vercel`, `firebase`, and `netlify` store their tokens.

## Sandbox commands

The sandbox is a shared WhatsApp and Instagram environment managed by
HookMyApp for local development. All sandbox operations live under
`hookmyapp sandbox`. Identifiers are shape-detected: pass a `+phone`
(WhatsApp), an `@username` (Instagram), or an `ssn_XXXXXXXX` session id as a
positional, or use the explicit `--phone` / `--username` / `--session`
selectors:

```bash
hookmyapp sandbox start [whatsapp|instagram]       # bind a session (prompts if no type)
hookmyapp sandbox start --type=instagram           # flag form also works
hookmyapp sandbox status
hookmyapp sandbox stop --session ssn_XXXXXXXX
hookmyapp sandbox env --phone +15551234567 --write .env
hookmyapp sandbox env --username @your-handle --write .env
hookmyapp sandbox send --username @your-handle --message "hello"
hookmyapp sandbox logs --username @your-handle
hookmyapp sandbox webhook show --phone +15551234567
hookmyapp sandbox webhook set --username @your-handle --url https://example.com/webhook
hookmyapp sandbox webhook clear --username @your-handle
hookmyapp sandbox listen --username @your-handle --port 3000
```

Add `--json` to any of these for machine-readable output.

### Sandbox env values

`sandbox env` emits a different key shape from `channels env`. Sandbox blocks
always include a `PORT` line and use the `*_API_URL` and `INSTAGRAM_ACCOUNT_ID`
names (real channels use `*_GRAPH_API_URL` and `INSTAGRAM_USER_ID` instead).

WhatsApp sandbox:

```bash
VERIFY_TOKEN=...
PORT=3000
WHATSAPP_API_URL=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
```

Instagram sandbox:

```bash
VERIFY_TOKEN=...
PORT=3000
INSTAGRAM_API_URL=...
INSTAGRAM_ACCESS_TOKEN=...
INSTAGRAM_ACCOUNT_ID=...
```

## Telemetry

HookMyApp CLI reports crashes to our Sentry project so we can fix bugs fast.
**No command arguments, file contents, or environment variable values are
sent.** Only the error class, stack trace, CLI version, platform, and (when
you are logged in) your WorkOS user id are reported.

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
