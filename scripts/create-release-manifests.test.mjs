import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createReleaseManifests,
  RELEASE_PLATFORM_SELECTIONS,
  RELEASE_PLATFORMS,
} from "./create-release-manifests.mjs";
import { PRODUCTION_BASE_URL } from "./desktop-channel.mjs";
import { preparePublishedRelease } from "./prepare-published-release.mjs";

const EXPECTED_ARTIFACT_COUNT = RELEASE_PLATFORMS.reduce(
  (count, descriptor) =>
    count + descriptor.architectures.length * descriptor.formats.length,
  0,
);

function releaseFixture(version = "0.4.2", platforms = RELEASE_PLATFORMS) {
  const dist = mkdtempSync(path.join(tmpdir(), "tidebreak-release-"));
  for (const descriptor of platforms) {
    for (const arch of descriptor.architectures) {
      const directory = path.join(dist, descriptor.platform, arch);
      mkdirSync(directory, { recursive: true });
      const baseName = `Tidebreak_${version}_${arch}`;
      for (const format of descriptor.formats) {
        const file = path.join(directory, `${baseName}${format.extension}`);
        writeFileSync(file, `${format.format}-${descriptor.platform}-${arch}`);
        if (format.updater) {
          writeFileSync(
            `${file}.sig`,
            `signature-${descriptor.platform}-${arch}-${format.format}\n`,
          );
        }
      }
    }
  }
  return dist;
}

const RELEASE = {
  version: "0.4.2",
  tag: "v0.4.2",
  sha: "0123456789abcdef0123456789abcdef01234567",
  publishedAt: "2026-07-22T16:00:00Z",
  baseUrl: "https://github.com/naingthet/tidebreak/releases/download",
};

const DOWNLOAD = "https://github.com/naingthet/tidebreak/releases/download/v0.4.2/";

test("creates a complete manifest and Tauri updater document", () => {
  const dist = releaseFixture();
  const { manifest, latest } = createReleaseManifests({ dist, ...RELEASE });

  assert.equal(manifest.artifacts.length, EXPECTED_ARTIFACT_COUNT);
  assert.deepEqual(Object.keys(latest.platforms), [
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64",
    "windows-aarch64",
    "linux-x86_64-appimage",
    "linux-aarch64-appimage",
    "linux-x86_64-deb",
    "linux-aarch64-deb",
  ]);
  assert.equal(
    latest.platforms["darwin-aarch64"].url,
    `${DOWNLOAD}Tidebreak_0.4.2_universal.app.tar.gz`,
  );
  assert.equal(
    latest.platforms["darwin-aarch64"].signature,
    "signature-macos-universal-app.tar.gz",
  );
  assert.deepEqual(
    latest.platforms["darwin-x86_64"],
    latest.platforms["darwin-aarch64"],
  );
  assert.equal(
    latest.platforms["windows-x86_64"].url,
    `${DOWNLOAD}Tidebreak_0.4.2_x86_64-setup.exe`,
  );
  assert.equal(
    latest.platforms["windows-x86_64"].signature,
    "signature-windows-x86_64-nsis",
  );
  assert.equal(
    latest.platforms["windows-aarch64"].url,
    `${DOWNLOAD}Tidebreak_0.4.2_aarch64-setup.exe`,
  );
  assert.equal(
    latest.platforms["windows-aarch64"].signature,
    "signature-windows-aarch64-nsis",
  );
  assert.equal(
    latest.platforms["linux-x86_64-appimage"].url,
    `${DOWNLOAD}Tidebreak_0.4.2_x86_64.AppImage`,
  );
  assert.equal(
    latest.platforms["linux-x86_64-appimage"].signature,
    "signature-linux-x86_64-appimage",
  );
  assert.equal(
    latest.platforms["linux-x86_64-deb"].url,
    `${DOWNLOAD}Tidebreak_0.4.2_x86_64.deb`,
  );
  assert.equal(
    latest.platforms["linux-x86_64-deb"].signature,
    "signature-linux-x86_64-deb",
  );
  assert.equal(
    latest.platforms["linux-aarch64-appimage"].url,
    `${DOWNLOAD}Tidebreak_0.4.2_aarch64.AppImage`,
  );
  assert.equal(
    latest.platforms["linux-aarch64-appimage"].signature,
    "signature-linux-aarch64-appimage",
  );
  assert.equal(
    latest.platforms["linux-aarch64-deb"].url,
    `${DOWNLOAD}Tidebreak_0.4.2_aarch64.deb`,
  );
  assert.equal(
    latest.platforms["linux-aarch64-deb"].signature,
    "signature-linux-aarch64-deb",
  );

  const diskManifest = JSON.parse(
    readFileSync(path.join(dist, "manifest.json"), "utf8"),
  );
  assert.deepEqual(diskManifest, manifest);
  for (const artifact of manifest.artifacts) {
    assert.equal(artifact.sha256.length, 64);
    assert.equal(artifact.url, `${DOWNLOAD}${artifact.filename}`);
    assert.doesNotMatch(artifact.filename, /\//);
    assert.equal(artifact.checksum_url, `${DOWNLOAD}${artifact.filename}.sha256`);
    assert.equal(
      readFileSync(
        path.join(dist, artifact.platform, artifact.arch, artifact.filename) +
          ".sha256",
        "utf8",
      ),
      `${artifact.sha256}  ${artifact.filename}\n`,
    );
  }
});

test("fails closed when an architecture is incomplete", () => {
  const dist = releaseFixture();
  const missing = path.join(
    dist,
    "macos",
    "universal",
    "Tidebreak_0.4.2_universal.app.tar.gz.sig",
  );
  writeFileSync(missing, "");

  assert.throws(
    () => createReleaseManifests({ dist, ...RELEASE }),
    /empty updater signature/,
  );
});

test("rejects mismatched tags and any feed outside this repository's releases", () => {
  const dist = releaseFixture();
  assert.throws(
    () => createReleaseManifests({ dist, ...RELEASE, tag: "v0.4.3" }),
    /does not select version/,
  );
  assert.throws(
    () =>
      createReleaseManifests({
        dist,
        ...RELEASE,
        baseUrl: "https://example.com/tidebreak",
      }),
    /https:\/\/github\.com release download URL/,
  );
  assert.throws(
    () =>
      createReleaseManifests({
        dist,
        ...RELEASE,
        baseUrl: "https://downloads.example.io/tidebreak",
      }),
    /https:\/\/github\.com release download URL/,
  );
  assert.throws(
    () =>
      createReleaseManifests({
        dist,
        ...RELEASE,
        baseUrl: "https://github.com/someone-else/tidebreak/releases/download",
      }),
    /production base URL must be https:\/\/github\.com\/naingthet\/tidebreak\/releases\/download/,
  );
  assert.equal(RELEASE.baseUrl, PRODUCTION_BASE_URL);
});

test("recreates latest metadata from an authoritative published manifest", () => {
  const dist = releaseFixture();
  const created = createReleaseManifests({ dist, ...RELEASE });
  const latestPath = path.join(dist, "resumed-latest.json");
  const resumed = preparePublishedRelease({
    manifestPath: path.join(dist, "manifest.json"),
    latestPath,
    ...RELEASE,
  });

  assert.deepEqual(resumed.latest, created.latest);
  assert.deepEqual(
    JSON.parse(readFileSync(latestPath, "utf8")),
    created.latest,
  );
});

test("rejects a published manifest that points outside its release's downloads", () => {
  const dist = releaseFixture();
  createReleaseManifests({ dist, ...RELEASE });
  const manifestPath = path.join(dist, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.artifacts[0].url = "https://example.com/Tidebreak.dmg";
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

  assert.throws(
    () =>
      preparePublishedRelease({
        manifestPath,
        latestPath: path.join(dist, "latest-resumed.json"),
        ...RELEASE,
      }),
    /unexpected artifact URL/,
  );
});

test("a macOS-only selection publishes only the macOS platform", () => {
  const dist = releaseFixture("0.4.2", RELEASE_PLATFORM_SELECTIONS.macos);
  const { manifest, latest } = createReleaseManifests({
    dist,
    ...RELEASE,
    platformSelection: "macos",
  });

  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.platform),
    ["macos", "macos", "macos"],
  );
  // No Windows or Linux key: an installed app on those platforms sees no
  // update rather than a pointer at a build that does not exist.
  assert.deepEqual(Object.keys(latest.platforms), [
    "darwin-aarch64",
    "darwin-x86_64",
  ]);

  const latestPath = path.join(dist, "resumed-latest.json");
  const resumed = preparePublishedRelease({
    manifestPath: path.join(dist, "manifest.json"),
    latestPath,
    ...RELEASE,
    platformSelection: "macos",
  });
  assert.deepEqual(resumed.latest, latest);
});

test("a platform selection must match the artifacts it is checked against", () => {
  const dist = releaseFixture("0.4.2", RELEASE_PLATFORM_SELECTIONS.macos);
  assert.throws(
    () => createReleaseManifests({ dist, ...RELEASE }),
    /required release artifact is missing/,
  );
  assert.throws(
    () =>
      createReleaseManifests({
        dist,
        ...RELEASE,
        platformSelection: "windows",
      }),
    /unknown release platform selection: windows/,
  );

  const full = releaseFixture();
  createReleaseManifests({ dist: full, ...RELEASE });
  assert.throws(
    () =>
      preparePublishedRelease({
        manifestPath: path.join(full, "manifest.json"),
        latestPath: path.join(full, "latest-resumed.json"),
        ...RELEASE,
        platformSelection: "macos",
      }),
    /unexpected artifact count/,
  );
});
