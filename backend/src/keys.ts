import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Per-bot signing keys, encrypted at rest.
 *
 * Be clear about what this does and does not buy. AES-256-GCM with a server
 * held secret protects a stolen disk, a leaked backup, or a copied JSON file.
 * It does NOT protect a compromised process: to sign, this server decrypts,
 * so anything that can run code here can read every key. That is custody.
 *
 * Consequences of that, enforced below:
 *   - the plaintext key never leaves this module, and is never logged or returned
 *   - a missing secret is a hard failure, never a silent fall back to plaintext
 *   - the derived address is stored alongside, so a bot can be identified
 *     without ever decrypting
 */
const ALGO = "aes-256-gcm";
const SECRET = process.env.KEY_ENCRYPTION_SECRET ?? "";

export type SealedKey = { iv: string; tag: string; salt: string; data: string; address: string };

export function keyStorageReady(): boolean {
  return SECRET.length >= 32;
}

function derive(salt: Buffer): Buffer {
  // Per-record salt, so two bots holding the same key do not share ciphertext.
  return scryptSync(SECRET, salt, 32);
}

export function normalizeKey(raw: string): string | null {
  const trimmed = raw.trim();
  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  return /^0x[0-9a-fA-F]{64}$/.test(withPrefix) ? withPrefix.toLowerCase() : null;
}

/** The address a key controls, for confirming the operator pasted the right one. */
export function addressOf(privateKey: string): string | null {
  try {
    return privateKeyToAccount(privateKey as `0x${string}`).address.toLowerCase();
  } catch {
    return null;
  }
}

export function seal(privateKey: string): SealedKey | null {
  if (!keyStorageReady()) return null;
  const address = addressOf(privateKey);
  if (!address) return null;

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, derive(salt), iv);
  const data = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);

  return {
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    salt: salt.toString("hex"),
    data: data.toString("hex"),
    address,
  };
}

/**
 * Only for a signer. Returns null rather than throwing so a caller cannot
 * accidentally surface the reason a key failed to open.
 */
export function open(sealed: SealedKey): string | null {
  if (!keyStorageReady()) return null;
  try {
    const decipher = createDecipheriv(ALGO, derive(Buffer.from(sealed.salt, "hex")), Buffer.from(sealed.iv, "hex"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
    const out = Buffer.concat([decipher.update(Buffer.from(sealed.data, "hex")), decipher.final()]).toString("utf8");

    // The tag already proves integrity; this catches a mismatched record.
    const expected = Buffer.from(sealed.address);
    const actual = Buffer.from(addressOf(out) ?? "");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return out;
  } catch {
    return null;
  }
}
