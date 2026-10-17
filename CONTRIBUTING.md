# Contributing to macro-cache

Thanks for helping! macro-cache is a single-user, self-hosted app, so every change should keep it cheap to run (Cloudflare free tier), private by default, and safe.

## Getting started

```bash
npm ci
npm test          # must pass
npm run typecheck # must pass
```

See the README's **Development** section for running the Worker and dashboard locally.

## Ground rules

- **Numbers live in `packages/core`.** Any calculation the user sees (targets, projections, progress, validation) belongs in the pure core module, with unit tests. The Worker and dashboard both import it, so their numbers can't drift apart.
- **Every write goes through `Writer`** (`apps/worker/src/services/context.ts`), so it is audit-logged and undoable. New write tools must support `dry_run` and run plausibility validation.
- **No generic network access from tools.** Don't add tools that fetch arbitrary URLs. Open Food Facts by barcode is the only outbound call. See [SECURITY.md](SECURITY.md).
- **Safety floors are not optional.** Don't add paths that set or suggest intake below the floor, or that skip the under-18 gate.
- **Tool descriptions are part of the security model.** Tools that can receive web or photo content must keep the untrusted-data warning.
- **Schema changes:** edit `apps/worker/src/db/schema.ts`, then run `npm run db:generate` and commit the new migration.
- **Neutral language.** No "good/bad food" labels or shaming copy anywhere in the UI or tool output.

## Pull requests

- Keep PRs focused, add tests, and describe the user-facing change.
- For UI changes, include a screenshot at phone width (360–390 px).

## Food data

If a barcode isn't found, please [contribute the product to Open Food Facts](https://world.openfoodfacts.org/contribute). It helps every user of the open database.
