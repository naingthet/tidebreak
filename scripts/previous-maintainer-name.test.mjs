import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Tidebreak's previous maintainer is named only where the Apache-2.0 license
// requires it: LICENSE and NOTICE. The app identity keeps its reverse-DNS form
// until a separate change migrates it, so that exact string is allowed too.
// Everything else in the tree uses neutral wording or the project's own home.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const self = relative(root, fileURLToPath(import.meta.url));
const ALLOWED_FILES = new Set(["LICENSE", "NOTICE", self]);
const IDENTITY = "io.brightwave.tidebreak";
const NAME = /brightwave/i;

export function lineNamesPreviousMaintainer(line) {
  return NAME.test(line.split(IDENTITY).join(""));
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    // `git grep` exits 1 when nothing matches.
    if (error.status === 1) return "";
    throw error;
  }
}

test("only the identity string counts as an allowed mention", () => {
  assert.equal(lineNamesPreviousMaintainer(`identifier: "${IDENTITY}"`), false);
  assert.equal(lineNamesPreviousMaintainer(`${IDENTITY}.dev and ${IDENTITY}.cu-helper`), false);
  assert.equal(lineNamesPreviousMaintainer("io.brightwave.another-product"), true);
  assert.equal(lineNamesPreviousMaintainer("io.brightwavex.tidebreak"), true);
  assert.equal(lineNamesPreviousMaintainer("Copyright BrightWave, Inc."), true);
  assert.equal(lineNamesPreviousMaintainer("ghcr.io/brightwave-inc/image"), true);
});

test(
  "the tree names the previous maintainer only in LICENSE and NOTICE",
  { skip: !existsSync(join(root, ".git")) && "not a git checkout" },
  () => {
    const offenders = [];

    for (const path of git(["ls-files"]).split("\n").filter(Boolean)) {
      if (!ALLOWED_FILES.has(path) && NAME.test(path)) {
        offenders.push(`${path}: the path itself`);
      }
    }

    // Text files, line by line, so the identity string can be allowed.
    for (const match of git(["grep", "-I", "-n", "-i", "brightwave"]).split("\n")) {
      if (!match) continue;
      const [path, line, ...rest] = match.split(":");
      if (ALLOWED_FILES.has(path)) continue;
      if (lineNamesPreviousMaintainer(rest.join(":"))) {
        offenders.push(`${path}:${line}: ${rest.join(":").trim().slice(0, 120)}`);
      }
    }

    // Binary files carry no identity string, so any match is an offender.
    const textMatches = new Set(
      git(["grep", "-I", "-l", "-i", "brightwave"]).split("\n").filter(Boolean),
    );
    for (const path of git(["grep", "-l", "-i", "brightwave"]).split("\n")) {
      if (path && !textMatches.has(path) && !ALLOWED_FILES.has(path)) {
        offenders.push(`${path}: binary content`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Use neutral wording or github.com/naingthet/tidebreak instead:\n${offenders.join("\n")}`,
    );
  },
);
