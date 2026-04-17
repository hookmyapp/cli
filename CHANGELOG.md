# Changelog

All notable changes to `@gethookmyapp/cli` are documented here.

## [0.5.0] - 2026-04-17

### Breaking Changes

- All id flags (`--workspace`, `--session`) now require Stripe-style
  publicId format (e.g. `ws_A4zq8d2T`, `ch_a4Zq8d2T`, `ssn_3Bq8RkP2`).
  Raw UUIDs are rejected with a typed validation error (exit 2) before
  the CLI ever talks to the backend.
- `workspace use <name-or-id>` accepts a ws_ publicId, a workspace name,
  or a WorkOS organizationId slug. Raw UUID is rejected.
- `workspace invites cancel <id-or-email>` expects an `inv_` publicId
  (was raw UUID) or an email address.
- Stored config (`~/.hookmyapp/config.json`) field `activeWorkspaceId`
  now carries a `ws_` publicId. Any pre-0.5.0 config with a UUID value
  is silently dropped on read — the CLI falls through to the login
  wizard's workspace picker (or single-workspace auto-select) on the
  next command. The `env` slice of the file (managed by
  `hookmyapp config set env ...`) is preserved across the drop.
- Requires backend Phase 117 or later. Monorepo main contains the
  boundary-strict handlers that reject raw UUIDs; older backends that
  still accept UUIDs will appear to work but are out of contract.

### Migration

- Re-run `hookmyapp login` (or `hookmyapp workspace use <name>`) on
  upgrade to refresh the config file with the publicId shape.
- Any scripts / CI using `--workspace=<uuid>` or
  `hookmyapp sandbox listen --session=<uuid>` must be updated to
  `--workspace=ws_<8-char>` / `--session=ssn_<8-char>` using the
  publicId shown in `hookmyapp workspace list` /
  `hookmyapp sandbox status`.
- Meta OAuth redirect URL is unchanged (`${appUrl}/cli/callback`);
  the frontend cli-callback (Phase 117-03) now hands the publicId
  back to the CLI end-to-end.

### Internals

- New `src/lib/publicId.ts` — a verbatim copy of the 62-char
  Stripe-style alphabet + `isValidPublicId` regex from
  `@hookmyapp/shared`. `@hookmyapp/shared` is a monorepo-internal
  workspace package that is not published to npm, so the CLI uses
  this local fallback rather than a cross-repo dependency. Keep the
  alphabet / length / prefix list in sync manually on future changes.

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
