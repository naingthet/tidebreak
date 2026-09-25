import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_CHANNELS,
  PRODUCTION_BASE_URL,
  PRODUCTION_UPDATER_ENDPOINT,
  desktopChannel,
  releaseAssetUrl,
} from "./desktop-channel.mjs";

test("production publishes from this repository's GitHub releases", () => {
  const production = desktopChannel("production");

  assert.equal(
    PRODUCTION_BASE_URL,
    "https://github.com/naingthet/tidebreak/releases/download",
  );
  assert.equal(
    PRODUCTION_UPDATER_ENDPOINT,
    "https://github.com/naingthet/tidebreak/releases/latest/download/latest.json",
  );
  assert.equal(production.baseUrl, PRODUCTION_BASE_URL);
  assert.equal(production.updaterEndpoint, PRODUCTION_UPDATER_ENDPOINT);
  assert.equal(production.identifier, "io.github.naingthet.tidebreak");
  assert.equal(production.environment, "desktop-production");
  assert.deepEqual(Object.keys(DESKTOP_CHANNELS), ["production"]);
  assert.throws(() => desktopChannel("staging"), /unknown desktop channel/);
});

test("release asset URLs name one flat file under the tag's download path", () => {
  assert.equal(
    releaseAssetUrl(PRODUCTION_BASE_URL, "v1.2.3", "Tidebreak_1.2.3_universal.app.tar.gz"),
    "https://github.com/naingthet/tidebreak/releases/download/v1.2.3/Tidebreak_1.2.3_universal.app.tar.gz",
  );
  assert.equal(
    releaseAssetUrl(PRODUCTION_BASE_URL, "v1.2.3", "a b.json"),
    "https://github.com/naingthet/tidebreak/releases/download/v1.2.3/a%20b.json",
  );
  assert.throws(
    () => releaseAssetUrl(PRODUCTION_BASE_URL, "v1.2.3", "macos/Tidebreak.dmg"),
    /flat file names/,
  );
  assert.throws(
    () => releaseAssetUrl(PRODUCTION_BASE_URL, "v1.2.3", ""),
    /flat file names/,
  );
});
