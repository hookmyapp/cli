# Changelog

All notable changes to `@gethookmyapp/cli` are documented here.

## [0.4.0] - 2026-04-16

### Breaking Changes

- Renamed `accounts` command group to `channels` (6 subcommands: `list`,
  `show`, `connect`, `disconnect`, `enable`, `disable`). Rationale:
  product-wide rename from `Account` to `Channel` as the canonical noun
  for a WhatsApp connection (industry standard: Twilio, Intercom, Front,
  Zendesk). Leaves room for future non-WhatsApp channels. See HookMyApp
  Phase 116 in the monorepo.
- The `--next accounts` flag on `hookmyapp login` is now `--next channels`.
- `hookmyapp workspace current` now labels the count row as `Channels:`
  (was `Accounts:`) and reads the `channelCount` field from the API.
- Requires backend Phase 116 or later; the CLI talks to
  `/meta/channels/*` endpoints — old builds that still serve
  `/meta/accounts/*` will 404.

### Migration

Replace `hookmyapp accounts <subcommand>` with
`hookmyapp channels <subcommand>` in scripts or documentation. The
6 subcommands are identical in behavior; only the noun has changed.

There is no alias; `hookmyapp accounts list` now exits with
`unknown command 'accounts'` per the pre-production hard-rename policy.

## [0.3.0] - 2026-04-14

- CLI output primitives + global `--workspace` flag (see Phase 108-04).

## [0.2.0] and earlier

Historical releases; no changelog was tracked prior to this version.
