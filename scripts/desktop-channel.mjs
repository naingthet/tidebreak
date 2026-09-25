#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Tidebreak ships from GitHub Releases on its own repository. Each release's
// files live under that tag's download path, and GitHub's `latest` redirect
// serves the updater feed from the newest published release.
export const RELEASE_REPOSITORY = "naingthet/tidebreak";
export const PRODUCTION_BASE_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/download`;
export const PRODUCTION_UPDATER_ENDPOINT = `https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/latest.json`;

export const DESKTOP_CHANNELS = Object.freeze({
  production: Object.freeze({
    id: "production",
    identifier: "io.brightwave.tidebreak",
    productName: "Tidebreak",
    scheme: "tidebreak",
    environment: "desktop-production",
    baseUrl: PRODUCTION_BASE_URL,
    updaterEndpoint: PRODUCTION_UPDATER_ENDPOINT,
  }),
});

export function desktopChannel(id) {
  const channel = DESKTOP_CHANNELS[id];
  if (!channel) {
    throw new Error(`unknown desktop channel: ${id}`);
  }
  return channel;
}

// The public URL of one file attached to the release tagged `tag`.
export function releaseAssetUrl(baseUrl, tag, assetName) {
  if (!assetName || assetName.includes("/")) {
    throw new Error(`release asset names are flat file names: ${assetName}`);
  }
  return `${baseUrl}/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

function main() {
  const id = process.argv[2];
  if (!id) {
    throw new Error("usage: desktop-channel.mjs <production>");
  }
  const channel = desktopChannel(id);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(channel)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
  console.log(JSON.stringify(channel, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
