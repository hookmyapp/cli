# @gethookmyapp/cli

HookMyApp CLI — connect WhatsApp Business API in minutes.

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

## Documentation

Full docs: https://hookmyapp.com

## Issues

https://github.com/hookmyapp/hookmyapp/issues

## License

MIT
