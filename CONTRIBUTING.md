# Contributing to Bever

Thank you for helping build a portable, local-first notes application.

## Development principles

- Offline behavior must not depend on a network request.
- Do not silently discard note content, ENML, metadata, or attachments.
- Keep the Rust core independent of the UI shell.
- Prefer small, typed interfaces, transactional storage changes, parameterized queries, and explicit error handling.
- Optimize using measurements; preserve correctness before micro-optimizations.
- Never commit access tokens, client secrets, private ENEX exports, personal notes, or local application databases.

## Setup and checks

```sh
npm ci
npm run format
npm test
npm run test:core
npm run lint
npm run test:ui
```

For desktop changes, also build the application and drive it: `npm run tauri -- build --no-bundle`, then `npm run test:native`. That test starts the real application with a temporary library and never touches an installed one. Android changes require an APK build and, when available, on-device checks. A successful type check is not a substitute for testing the affected behavior; say in the pull request what you ran and what you could not.

Add or update tests for bug fixes, written so that they fail without the fix. ENEX tests should include source-preserving round trips and attachment hashes. Search changes need operator and relevance coverage. Sync changes are tested as round trips between two libraries through the in-memory remote in `sync/tests.rs`, including conflict, deletion, retry, and interrupted-run cases.

## Project layout

- `src/`: React interface, editor, stores, and their unit tests.
- `src-tauri/`: native commands, file access, OAuth, credential storage, the attachment protocol, and background workers.
- `crates/bever-core/`: reusable storage, ENEX, search, text recognition, and sync engine.
- `docs/`: architecture and compatibility contracts.
- `tests/`: browser and native-application checks.
- `scripts/`: version and release packaging, the icons, and the screenshots.
- `fastlane/`: what an Android store listing shows.

Use Prettier and rustfmt rather than hand-maintaining formatting. Keep unrelated refactors out of behavior changes. Update the documentation and `CHANGELOG.md` when changing behavior, and say so when a change alters the ENEX, database, or sync format.

## Security and privacy

Note content is untrusted. Do not add a command that accepts a file path or an arbitrary URL from the interface, and do not widen the WebView's permissions in `src-tauri/capabilities`; see the trust boundary in `docs/architecture.md`.

Use only official HTTPS service endpoints and validate remote hosts. Do not log credentials or complete note contents. New remote services require an explicit user connection and must remain optional. Report vulnerabilities privately as described in `SECURITY.md`.

By contributing, you agree that your contribution is licensed under GPL-3.0-or-later.
