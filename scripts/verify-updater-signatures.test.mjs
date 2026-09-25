import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  keyIdHex,
  verifyUpdaterSignature,
  verifyUpdaterSignatures,
} from "./verify-updater-signatures.mjs";

// A throwaway minisign keypair, built the way Tauri's signer lays one out.
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keyId = randomBytes(8);
  const line = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
  const text = `untrusted comment: minisign public key: ${keyIdHex(keyId)}\n${line}\n`;
  return { privateKey, keyId, encoded: Buffer.from(text).toString("base64") };
}

function signFile(pair, data, { algorithm = "ED", trustedComment = "timestamp:1700000000\tfile:app.tar.gz", keyId = pair.keyId } = {}) {
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  const signature = sign(null, message, pair.privateKey);
  const global = sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment)]),
    pair.privateKey,
  );
  const line = Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString("base64");
  const text = `untrusted comment: signature from tauri secret key\n${line}\ntrusted comment: ${trustedComment}\n${global.toString("base64")}\n`;
  return Buffer.from(text).toString("base64");
}

test("a signature from the committed key verifies, prehashed or not", () => {
  const pair = keypair();
  const data = Buffer.from("updater archive bytes");
  for (const algorithm of ["ED", "Ed"]) {
    assert.equal(
      verifyUpdaterSignature({
        publicKey: pair.encoded,
        signature: signFile(pair, data, { algorithm }),
        data,
      }),
      keyIdHex(pair.keyId),
    );
  }
});

test("a signature from another key, over other bytes, or with a forged comment fails", () => {
  const trusted = keypair();
  const other = keypair();
  const data = Buffer.from("updater archive bytes");

  assert.throws(
    () =>
      verifyUpdaterSignature({
        publicKey: trusted.encoded,
        signature: signFile(other, data),
        data,
      }),
    new RegExp(`signed with key ${keyIdHex(other.keyId)}, not the committed updater key`),
  );
  // Another key that claims the committed key id still fails the math.
  assert.throws(
    () =>
      verifyUpdaterSignature({
        publicKey: trusted.encoded,
        signature: signFile(other, data, { keyId: trusted.keyId }),
        data,
      }),
    /does not match the file/,
  );
  assert.throws(
    () =>
      verifyUpdaterSignature({
        publicKey: trusted.encoded,
        signature: signFile(trusted, data),
        data: Buffer.from("different bytes"),
      }),
    /does not match the file/,
  );

  const signed = Buffer.from(signFile(trusted, data), "base64")
    .toString()
    .replace("file:app.tar.gz", "file:other.tar.gz");
  assert.throws(
    () =>
      verifyUpdaterSignature({
        publicKey: trusted.encoded,
        signature: Buffer.from(signed).toString("base64"),
        data,
      }),
    /trusted comment does not verify/,
  );
  assert.throws(
    () => verifyUpdaterSignature({ publicKey: trusted.encoded, signature: "not base64!", data }),
    /not base64/,
  );
});

test("a directory is checked file by file and must hold at least one signature", () => {
  const pair = keypair();
  const root = mkdtempSync(path.join(tmpdir(), "tidebreak-updater-signatures-"));
  const config = path.join(root, "tauri.conf.json");
  writeFileSync(config, JSON.stringify({ plugins: { updater: { pubkey: pair.encoded } } }));
  const dist = path.join(root, "dist");
  mkdirSync(path.join(dist, "macos"), { recursive: true });

  assert.throws(
    () => verifyUpdaterSignatures({ configPath: config, targets: [dist] }),
    /found no updater signatures/,
  );

  const archive = path.join(dist, "macos", "Tidebreak_1.0.0_universal.app.tar.gz");
  writeFileSync(archive, "archive");
  writeFileSync(`${archive}.sig`, signFile(pair, Buffer.from("archive")));
  // Checksum sidecars of signatures are not signatures.
  writeFileSync(`${archive}.sig.sha256`, "digest  name\n");
  assert.deepEqual(verifyUpdaterSignatures({ configPath: config, targets: [dist] }), {
    count: 1,
    keyId: keyIdHex(pair.keyId),
  });

  writeFileSync(path.join(dist, "orphan.sig"), signFile(pair, Buffer.from("x")));
  assert.throws(
    () => verifyUpdaterSignatures({ configPath: config, targets: [dist] }),
    /orphan\.sig has no signed file beside it/,
  );
});
