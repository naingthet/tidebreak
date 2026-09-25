# Deploying Tidebreak mobile

The pipeline is EAS Build and EAS Submit for iOS, shipping to TestFlight
internal testing. Nothing in this repository is linked to an Expo or Apple
account. EAS, the Apple Developer Program, and App Store Connect all belong to
whoever ships the app, so link your own accounts first.

Legend: **(web)** = a web console, **(cli)** = a one-time interactive
terminal step, **(repo)** = already done in this repository.

## Already in the repository (repo)

- `assets/icon.png` — 1024×1024, opaque, no alpha channel (an alpha
  channel is the classic silent TestFlight rejection). Derived from the
  desktop app icon; Expo derives every other iOS size at build time.
- `app.config.ts` — `icon`, the bundle ids (`io.github.naingthet.tidebreak`,
  with `.staging` and `.dev` for the other variants), and export compliance
  pre-answered (`ITSAppUsesNonExemptEncryption: false`). Only
  secure-store/web-browser ship, so no `NS*UsageDescription` strings are
  owed yet; add one alongside any permission-touching module.
  **No `ios.buildNumber` anywhere** — the build number lives in EAS's
  remote counter. Variant selection is `APP_VARIANT`
  (production/staging/development).
- `expo-updates` + `runtimeVersion: { policy: "fingerprint" }` — present
  from the very first binary so that binary already establishes the OTA
  fingerprint baseline (builds made without the dependency can never
  receive OTAs).
- `eas.json` — `appVersionSource: "remote"`; a `development` profile
  (dev client, internal) and one `production` shipping profile with the
  two lines everyone forgets: `autoIncrement: true` (without it every
  build reuses the same number and TestFlight rejects the second upload)
  and an explicit `environment`.
- `.gitignore` — refuses `.p8`/`.p12`/keystores; EAS holds the real
  copies.

## One-time setup, in order

1. **(cli)** `pnpm dlx eas-cli@latest login` with your Expo account, then
   run `eas init` in `mobile/`. Paste the project id it prints into
   `EAS_PROJECT_ID` in `app.config.ts`; eas-cli cannot write into a dynamic
   TS config.
2. **(web)** Register the bundle id under your Apple team and create the
   App Store Connect app record. Add
   `"submit": { "production": { "ios": { "ascAppId": "<numeric Apple ID>" } } }`
   to `eas.json` so submissions run without prompting.
3. **(cli)** `APP_VARIANT=production eas credentials --platform ios` —
   choose App Store Connect API Key and upload a team key. EAS mints and
   stores the distribution certificate and provisioning profile, and
   submits stay non-interactive from then on.
4. **(cli)** `eas build --profile production --platform ios
   --auto-submit`.
5. **(web)** After the build reaches TestFlight (about 5–15 minutes after
   processing): TestFlight → Internal Testing → create a group and add
   testers. Internal testers need no Beta App Review.

## Later, deliberately deferred

- **Android / Play Console** — package ids are already configured per
  variant; the Play record, service-account key, keystore, and the
  Console-UI-only first upload come when a slice needs them. Until then CI
  routes iOS only — see the next section.
- **Per-variant icons** (tinted dev/staging) and a branded splash via
  the `expo-splash-screen` config plugin. The current icon is derived
  from the desktop tile; swap in a purpose-made 1024×1024 opaque source
  when design supplies one.

## OTA + CI

`.github/workflows/build-mobile.yml` runs only when you dispatch it (Actions →
**Build and Submit Mobile** → **Run workflow**). Without an `EXPO_TOKEN`
secret it reports a notice and skips the deploy job, which counts as a pass.
With one, it routes by fingerprint:

- The local `@expo/fingerprint` hash — computed with the project-resolved
  binary (`pnpm exec fingerprint`, which ships inside the pinned `expo`
  package), under the EAS `production` environment and
  `APP_VARIANT=production` — is compared against the last finished EAS
  build's `runtimeVersion`, per platform.
- **Hashes match** → `eas update` publishes an OTA to the `production`
  channel; installed clients pick it up on next launch. JS-only changes
  never touch the store.
- **Any mismatch** (native dep, config plugin, SDK bump — or no prior
  build) → `eas build --auto-submit` ships a binary to TestFlight.
- Dispatch with **Dry run** to see the routing table without publishing or
  building anything.

Routing is currently **iOS-only**, and that restriction is on routing, not
just on submission: with no finished Android build in EAS there is no
`runtimeVersion` for an `android` row to match, so including it would miss
on every run and pin the mode to `build` forever — the OTA path would never
fire. `eas update` still publishes both platforms' bundles. The workflow's
routing loop is already per-platform; enabling Android once the Play
Console setup above lands is a one-line change of the `PLATFORM` default
from `ios` to `all`.

There is no root `.nvmrc` here, so Node and pnpm are set up the way
`.github/workflows/mobile-checks.yml` does it (pnpm from
`mobile/package.json`'s `packageManager` pin, Node pinned explicitly).
Keep the two mobile workflows in step when either changes.

Fingerprint discipline: nothing non-deterministic in `app.config.ts` — a
value that changes between runs makes every build look like a native change
and the OTA path never fires.

To let the workflow reach EAS, add an Expo access token as a repository
secret:

```sh
gh secret set EXPO_TOKEN -R naingthet/tidebreak
```

The value is an Expo access token (expo.dev → Access tokens; a robot token
survives personnel changes).
