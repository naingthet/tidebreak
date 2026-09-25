#!/usr/bin/env node

// Verify Tauri updater signatures against the public key installed apps
// trust, before anything is published. A signature made with any other key
// would ship a release that every installed app refuses to install.
//
// Tauri signatures are minisign signatures, base64-encoded as a whole file:
// an untrusted comment, a signature line (algorithm, key id, and an Ed25519
// signature over the file, or over its BLAKE2b-512 hash when the algorithm is
// `ED`), a trusted comment, and a global signature over the signature and the
// trusted comment. The public key in tauri.conf.json is a base64-encoded
// minisign public key file.

import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TRUSTED_COMMENT = "trusted comment: ";

function decodeBase64Text(value, what) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/=\s]+$/.test(value)) {
    throw new Error(`${what} is not base64`);
  }
  return Buffer.from(value.trim(), "base64").toString("utf8");
}

// minisign prints a key id as its little-endian integer in hex.
export function keyIdHex(keyId) {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

export function parsePublicKey(encoded) {
  const lines = decodeBase64Text(encoded, "the public key")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 2 || !lines[0].startsWith("untrusted comment:")) {
    throw new Error("the public key is not a minisign public key");
  }
  const raw = Buffer.from(lines[1], "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("the public key is not an Ed25519 minisign key");
  }
  return {
    keyId: raw.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10)]),
      format: "der",
      type: "spki",
    }),
  };
}

export function parseSignature(encoded) {
  const lines = decodeBase64Text(encoded, "the signature")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""));
  const [untrusted, signatureLine, trusted, globalLine] = lines;
  if (
    !untrusted?.startsWith("untrusted comment:") ||
    !trusted?.startsWith(TRUSTED_COMMENT) ||
    !signatureLine ||
    !globalLine ||
    lines.slice(4).some((line) => line.trim())
  ) {
    throw new Error("the signature is not a minisign signature");
  }
  const raw = Buffer.from(signatureLine.trim(), "base64");
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (raw.length !== 74 || (algorithm !== "Ed" && algorithm !== "ED")) {
    throw new Error("the signature is not an Ed25519 minisign signature");
  }
  const globalSignature = Buffer.from(globalLine.trim(), "base64");
  if (globalSignature.length !== 64) {
    throw new Error("the signature's trusted comment is not signed");
  }
  return {
    algorithm,
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10),
    trustedComment: trusted.slice(TRUSTED_COMMENT.length),
    globalSignature,
  };
}

export function verifyUpdaterSignature({ publicKey, signature, data }) {
  const trusted = parsePublicKey(publicKey);
  const signed = parseSignature(signature);
  if (!signed.keyId.equals(trusted.keyId)) {
    throw new Error(
      `signed with key ${keyIdHex(signed.keyId)}, not the committed updater key ${keyIdHex(trusted.keyId)}`,
    );
  }
  const message =
    signed.algorithm === "ED"
      ? createHash("blake2b512").update(data).digest()
      : data;
  if (!verify(null, message, trusted.key, signed.signature)) {
    throw new Error("the signature does not match the file");
  }
  const comment = Buffer.concat([
    signed.signature,
    Buffer.from(signed.trustedComment, "utf8"),
  ]);
  if (!verify(null, comment, trusted.key, signed.globalSignature)) {
    throw new Error("the signature's trusted comment does not verify");
  }
  return keyIdHex(trusted.keyId);
}

function signatureFiles(target) {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { recursive: true })
    .map((entry) => path.join(target, String(entry)))
    .filter((file) => file.endsWith(".sig") && statSync(file).isFile())
    .sort();
}

export function verifyUpdaterSignatures({ configPath, targets }) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const publicKey = config?.plugins?.updater?.pubkey;
  if (typeof publicKey !== "string" || !publicKey) {
    throw new Error(`${configPath} has no plugins.updater.pubkey`);
  }
  const files = targets.flatMap(signatureFiles);
  if (files.length === 0) {
    throw new Error("found no updater signatures to verify");
  }
  let keyId = "";
  for (const signatureFile of files) {
    const artifact = signatureFile.slice(0, -".sig".length);
    if (!signatureFile.endsWith(".sig") || !existsSync(artifact)) {
      throw new Error(`${signatureFile} has no signed file beside it`);
    }
    try {
      keyId = verifyUpdaterSignature({
        publicKey,
        signature: readFileSync(signatureFile, "utf8"),
        data: readFileSync(artifact),
      });
    } catch (error) {
      throw new Error(`${signatureFile}: ${error.message}`);
    }
  }
  return { count: files.length, keyId };
}

function main() {
  const args = process.argv.slice(2);
  const configAt = args.indexOf("--config");
  if (configAt === -1 || !args[configAt + 1] || args.length < 3) {
    throw new Error(
      "usage: verify-updater-signatures.mjs --config <tauri.conf.json> <signature file or directory>...",
    );
  }
  const configPath = args[configAt + 1];
  const targets = args.filter((_, index) => index !== configAt && index !== configAt + 1);
  const { count, keyId } = verifyUpdaterSignatures({ configPath, targets });
  console.log(`Verified ${count} updater signature(s) against key ${keyId}.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
