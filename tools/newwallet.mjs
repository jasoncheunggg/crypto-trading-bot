#!/usr/bin/env node
// Generate a fresh EVM wallet, entirely offline.
//
// An EVM private key is 32 random bytes; the address is derived from it. Nothing is
// registered anywhere and no network call is made — you can run this with wifi off.
//
// Entropy comes from crypto.randomBytes (the OS CSPRNG), never Math.random.
//
// Correctness is not assumed: derive() is checked against published private-key -> address
// vectors on every run, and the script refuses to generate if they do not match. A wrong
// derivation produces an address nobody holds the key to, and funds sent there are gone.
import { randomBytes, createPublicKey, createPrivateKey } from "node:crypto";
import { existsSync, appendFileSync, chmodSync, readFileSync } from "node:fs";
import { keccak256 } from "./keccak.mjs";

/** secp256k1 public key from a 32-byte private key, uncompressed, without the 0x04 prefix. */
function pubFromPriv(priv) {
  // Build a DER SEC1 EC private key so node's crypto derives the public point for us.
  const der = Buffer.concat([
    Buffer.from("302e0201010420", "hex"), priv,
    Buffer.from("a00706052b8104000a", "hex"),
  ]);
  const key = createPrivateKey({ key: der, format: "der", type: "sec1" });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 64);          // uncompressed X||Y
}

function addressFrom(priv) {
  return "0x" + keccak256(pubFromPriv(priv)).subarray(12).toString("hex");
}

/** EIP-55 checksum casing, so a typo in the address is detectable. */
function checksum(addr) {
  const lower = addr.slice(2).toLowerCase();
  const hash = keccak256(Buffer.from(lower)).toString("hex");
  let out = "0x";
  for (let i = 0; i < lower.length; i++)
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

// --- self-test: published vectors. Refuse to run if these fail. -----------------
const VECTORS = [
  ["0000000000000000000000000000000000000000000000000000000000000001",
   "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"],
  ["4646464646464646464646464646464646464646464646464646464646464646",
   "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f"],
];
for (const [pk, want] of VECTORS) {
  const got = addressFrom(Buffer.from(pk, "hex"));
  if (got !== want) {
    console.error("SELF-TEST FAILED — refusing to generate a wallet.");
    console.error("  key " + pk.slice(0, 10) + "...  expected " + want + "  got " + got);
    process.exit(1);
  }
}
console.log("self-test: 2/2 published vectors match\n");

// --- generate ------------------------------------------------------------------
let priv;
do { priv = randomBytes(32); } while (priv.every((b) => b === 0));   // vanishingly unlikely
const address = checksum(addressFrom(priv));

console.log("  ADDRESS      " + address);
console.log("  private key  written to .env, not printed here");
console.log();

const line = `\n# Bot wallet, generated locally ${new Date().toISOString()}. BACK THIS UP.\n`
  + `# Losing it loses the funds — there is no recovery.\n`
  + `BOT_WALLET_ADDRESS=${address}\n`
  + `BOT_PRIVATE_KEY=0x${priv.toString("hex")}\n`;

if (existsSync(".env") && /^BOT_PRIVATE_KEY=/m.test(readFileSync(".env", "utf8"))) {
  console.log("  .env ALREADY HAS BOT_PRIVATE_KEY — not overwriting.");
  console.log("  Remove it first if you really want a new wallet.");
  process.exit(1);
}
appendFileSync(".env", line);
chmodSync(".env", 0o600);
console.log("  appended to .env (chmod 600)");
console.log();
console.log("  NEXT:");
console.log("   1. Back up the key from .env somewhere offline. No backup = no recovery.");
console.log("   2. Import " + address.slice(0, 10) + "... into Phantom as a WATCH-ONLY account.");
console.log("   3. Send $1 first. Confirm it arrives. Then move the rest.");
