import type { ConfigContext, ExpoConfig } from "expo/config";

type AppVariant = "production" | "staging" | "development";

const VARIANT: AppVariant =
  process.env.APP_VARIANT === "staging"
    ? "staging"
    : process.env.APP_VARIANT === "development"
      ? "development"
      : "production";

const SCHEME: Record<AppVariant, string> = {
  production: "tidebreak",
  staging: "tidebreak-staging",
  development: "tidebreak-dev",
};

// The app's identity on iOS and Android (decision 103). `.mobile` keeps it
// apart from the desktop app's identifier, which a Mac running the iOS app
// would otherwise share.
const BUNDLE_ID: Record<AppVariant, string> = {
  production: "io.github.naingthet.tidebreak.mobile",
  staging: "io.github.naingthet.tidebreak.mobile.staging",
  development: "io.github.naingthet.tidebreak.mobile.dev",
};

// Printed by `eas init` for the Expo project that ships this app (see
// DEPLOYING.md); eas-cli cannot write into a dynamic (TS) config, so the id is
// pasted here by hand. While it is empty, the EAS/updates fields are omitted
// entirely — a placeholder value makes `eas init` believe the project is
// already linked and fail.
const EAS_PROJECT_ID = "";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name:
    VARIANT === "production"
      ? "Tidebreak"
      : VARIANT === "staging"
        ? "Tidebreak Staging"
        : "Tidebreak Dev",
  slug: "tidebreak-mobile",
  version: "0.1.0",
  orientation: "portrait",
  scheme: SCHEME[VARIANT],
  userInterfaceStyle: "automatic",
  icon: "./assets/icon.png",
  // OTA updates (EAS Update). The fingerprint policy hashes every
  // native-relevant input, so an OTA only ever applies to binaries whose
  // native hash matches — JS-only changes ship over the air, native changes
  // force a store build. Keep this config deterministic: a value that changes
  // between runs breaks fingerprint routing.
  runtimeVersion: { policy: "fingerprint" },
  ...(EAS_PROJECT_ID
    ? {
        updates: {
          url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
          requestHeaders: {
            "expo-channel-name":
              VARIANT === "production"
                ? "production"
                : VARIANT === "staging"
                  ? "staging"
                  : "development",
          },
        },
      }
    : {}),
  ios: {
    supportsTablet: true,
    bundleIdentifier: BUNDLE_ID[VARIANT],
    infoPlist: {
      // Pre-answers export compliance; the app uses only HTTPS-exempt
      // encryption. Without this every TestFlight build waits on the
      // questionnaire.
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: BUNDLE_ID[VARIANT],
    adaptiveIcon: {
      backgroundColor: "#F7F8FA",
    },
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: false,
        data: [{ scheme: SCHEME[VARIANT], host: "callback" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
      // The gateway console's pairing link. Carries a gateway URL and a
      // claimable pairing-session handle, never a credential (mg ADR 0086),
      // so it is safe to accept from any source — `src/lib/provision.ts` is
      // what decides whether a given payload is one of ours.
      {
        action: "VIEW",
        autoVerify: false,
        data: [{ scheme: SCHEME[VARIANT], host: "provision" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-web-browser",
    // Scanning a pairing or attach QR. The permission string is what the OS
    // shows in the prompt, so it names the one thing the camera is for. It
    // covers both codes now: the gateway console's pairing code, and the
    // standalone machine's attach code (#3404, decision 98).
    [
      "expo-camera",
      {
        cameraPermission:
          "Tidebreak uses the camera only to scan the code that connects this phone to your gateway or your own Tidebreak machine.",
        recordAudioAndroid: false,
      },
    ],
    // Push. No `googleServicesFile` yet: without a Firebase config an Android
    // build has no FCM registration, so it registers its Expo token, never
    // claims it can render data-only messages, and receives ordinary
    // display-form notifications. iOS is unaffected.
    "expo-notifications",
  ],
  extra: {
    appVariant: VARIANT,
    oauthRedirectUri: `${SCHEME[VARIANT]}://callback`,
    ...(EAS_PROJECT_ID
      ? {
          eas: {
            projectId: EAS_PROJECT_ID,
          },
        }
      : {}),
  },
});
