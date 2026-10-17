# Unified scorecard preview — feature branch only

This branch is not deployed to the production app. Do not merge it or run its SQL in production while reviewing the UI.

## Safe local preview (no Supabase connection)

```sh
git switch feature/unified-scorecard-preview
npm ci
npm run preview:scorecard
```

Open the localhost URL printed by the command. The process hosts the app with temporary PGlite data and test authentication, never the configured Supabase project. Create a normal game with 1–4 names or a four-player Hussein game. Open the printed participant URL (`?account=1`) in another tab and join using the code. Accounts 0–4 are available. Stopping the process discards this test database. No browser binaries are needed for this interactive preview.

The same player-row, 18-hole-column table is used by both modes and by local and shared rounds. Names stay fixed while the holes scroll. OUT, IN and TOTAL are derived from entered scores. Select a hole heading to view its Hussein result, Near and lock controls. Normal rounds show none of these betting controls.

## SQL for a future, explicitly approved installation

`supabase/003-normal-shared-scorecard.sql` is an independent manual migration, after the existing `001-player-slots.sql` installation. It includes the score/Near/lock relaxation from 002 and replaces only golf_create, golf_join and golf_mutate; ownership, grants, RLS and all stored rows are preserved. It does not execute during app startup, preview, tests against production, build or branch push.

- New normal games have no player-slot policy. Registered members can edit every player's score; joining is not limited by the number of named golfers.
- Owner-only settings, stored hole locks, finalized protection, score validation and revision conflicts remain enforced.
- Versionless legacy game branches are unchanged. Their original participant limit and RPC behavior remain intact.
- Hussein teams, current-hole best-two-allies average, carry, Near and settlements are unchanged.

For a future approved DB change, pause writes, save the read-only `001-player-slots-precheck.sql` results, apply 003, then compare `001-player-slots-postcheck.sql` row counts/content fingerprints, function permissions and RLS against the saved results. Counts may exceed the historical 8/13/30 fixture; never reset records to those counts. `schema.sql` is only for new/test databases, not a production reset script.

## Checks

```sh
npm test
npm run test:browser
BROWSER=webkit npm run test:browser
```

The browser suite uses an isolated test database and transport. GitHub PR checks run Chromium and mobile WebKit without publishing Pages; Pages deploys only from main, which this preview does not update.
