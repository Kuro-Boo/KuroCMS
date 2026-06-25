// WebAuthn / Passkey verification for Cloudflare Workers.
// Supports ES256 (P-256 ECDSA) only. Uses Web Crypto API exclusively.

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

export function b64uEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function b64uDecode(s: string): Uint8Array {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Minimal CBOR decoder (major types 0,1,2,3,5 only)
// ---------------------------------------------------------------------------

type CborValue = number | bigint | Uint8Array | string | Map<unknown, unknown>;

function decodeCbor(data: Uint8Array, offset = 0): [CborValue, number] {
  const initialByte = data[offset];
  const majorType = (initialByte >> 5) & 0x07;
  const additionalInfo = initialByte & 0x1f;
  offset++;

  // Read the argument (length / value)
  let arg: number | bigint;
  if (additionalInfo < 24) {
    arg = additionalInfo;
  } else if (additionalInfo === 24) {
    arg = data[offset++];
  } else if (additionalInfo === 25) {
    arg = (data[offset] << 8) | data[offset + 1];
    offset += 2;
  } else if (additionalInfo === 26) {
    arg =
      ((data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3]) >>>
      0;
    offset += 4;
  } else if (additionalInfo === 27) {
    // 64-bit unsigned — use BigInt for safety
    const hi =
      ((data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3]) >>>
      0;
    const lo =
      ((data[offset + 4] << 24) |
        (data[offset + 5] << 16) |
        (data[offset + 6] << 8) |
        data[offset + 7]) >>>
      0;
    arg = (BigInt(hi) << 32n) | BigInt(lo);
    offset += 8;
  } else {
    throw new Error(`CBOR: unsupported additionalInfo ${additionalInfo}`);
  }

  const argNum = typeof arg === "bigint" ? Number(arg) : arg;

  switch (majorType) {
    case 0: // unsigned integer
      return [argNum, offset];

    case 1: // negative integer: -1 - arg
      return [-(argNum + 1), offset];

    case 2: {
      // byte string
      const bytes = data.slice(offset, offset + argNum);
      return [bytes, offset + argNum];
    }

    case 3: {
      // text string
      const textBytes = data.slice(offset, offset + argNum);
      return [new TextDecoder().decode(textBytes), offset + argNum];
    }

    case 5: {
      // map
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < argNum; i++) {
        let key: CborValue;
        let value: CborValue;
        [key, offset] = decodeCbor(data, offset);
        [value, offset] = decodeCbor(data, offset);
        map.set(key, value);
      }
      return [map, offset];
    }

    default:
      throw new Error(`CBOR: unsupported major type ${majorType}`);
  }
}

function parseCborMap(data: Uint8Array): Map<unknown, unknown> {
  const [value] = decodeCbor(data);
  if (!(value instanceof Map)) {
    throw new Error("CBOR: expected a map at top level");
  }
  return value;
}

// ---------------------------------------------------------------------------
// SHA-256 helper
// ---------------------------------------------------------------------------

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

// ---------------------------------------------------------------------------
// Authenticator data parser
// ---------------------------------------------------------------------------

interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  aaguid: string; // hex
  credentialId: Uint8Array | null;
  credentialPublicKeyBytes: Uint8Array | null;
}

const FLAG_UP = 0x01; // user presence
const FLAG_UV = 0x04; // user verification
const FLAG_AT = 0x40; // attested credential data included

function parseAuthenticatorData(authData: Uint8Array): AuthenticatorData {
  if (authData.length < 37) {
    throw new Error("WebAuthn: authenticatorData too short");
  }

  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const signCount =
    ((authData[33] << 24) |
      (authData[34] << 16) |
      (authData[35] << 8) |
      authData[36]) >>>
    0;

  let aaguid = "";
  let credentialId: Uint8Array | null = null;
  let credentialPublicKeyBytes: Uint8Array | null = null;

  if (flags & FLAG_AT) {
    // AAGUID: 16 bytes at offset 37
    const aaguidBytes = authData.slice(37, 53);
    aaguid = [...aaguidBytes]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // credentialIdLength: 2 bytes big-endian at offset 53
    const credIdLen = (authData[53] << 8) | authData[54];
    credentialId = authData.slice(55, 55 + credIdLen);
    credentialPublicKeyBytes = authData.slice(55 + credIdLen);
  }

  return {
    rpIdHash,
    flags,
    signCount,
    aaguid,
    credentialId,
    credentialPublicKeyBytes,
  };
}

// ---------------------------------------------------------------------------
// COSE key import (ES256 / P-256 only)
// ---------------------------------------------------------------------------

async function importCoseKey(
  coseKeyBytes: Uint8Array,
): Promise<{ spki: string; cryptoKey: CryptoKey }> {
  const map = parseCborMap(coseKeyBytes);

  const kty = map.get(1);
  const alg = map.get(3);
  const crv = map.get(-1);
  const xBytes = map.get(-2);
  const yBytes = map.get(-3);

  // kty=2 (EC2), alg=-7 (ES256), crv=1 (P-256)
  if (kty !== 2 || alg !== -7 || crv !== 1) {
    throw new Error(
      `WebAuthn: unsupported COSE key (kty=${kty}, alg=${alg}, crv=${crv})`,
    );
  }
  if (!(xBytes instanceof Uint8Array) || !(yBytes instanceof Uint8Array)) {
    throw new Error("WebAuthn: COSE key missing x or y coordinates");
  }

  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64uEncode(xBytes),
    y: b64uEncode(yBytes),
  };

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );

  const spkiBuffer = (await crypto.subtle.exportKey(
    "spki",
    cryptoKey,
  )) as ArrayBuffer;
  const spki = b64uEncode(new Uint8Array(spkiBuffer));

  return { spki, cryptoKey };
}

// ---------------------------------------------------------------------------
// Strip padding for base64url challenge comparison
// ---------------------------------------------------------------------------
function stripPadding(s: string): string {
  return s.replaceAll("=", "");
}

// ---------------------------------------------------------------------------
// Public types and functions
// ---------------------------------------------------------------------------

export interface VerifyRegistrationResult {
  credentialId: string;
  publicKeySpki: string;
  signCount: number;
  aaguid: string;
}

export async function verifyRegistration(
  challenge: string,
  rpId: string,
  response: {
    clientDataJSON: string; // base64url
    attestationObject: string; // base64url
  },
): Promise<VerifyRegistrationResult> {
  // 1. Decode and verify clientDataJSON
  const clientDataBytes = b64uDecode(response.clientDataJSON);
  const clientData = JSON.parse(
    new TextDecoder().decode(clientDataBytes),
  ) as Record<string, unknown>;

  if (clientData.type !== "webauthn.create") {
    throw new Error(
      `WebAuthn: unexpected clientData.type "${clientData.type}"`,
    );
  }
  if (stripPadding(String(clientData.challenge)) !== stripPadding(challenge)) {
    throw new Error("WebAuthn: challenge mismatch");
  }

  // Verify origin hostname matches rpId
  const origin = String(clientData.origin ?? "");
  const originHostname = new URL(origin).hostname;
  if (originHostname !== rpId) {
    throw new Error(
      `WebAuthn: origin hostname "${originHostname}" does not match rpId "${rpId}"`,
    );
  }

  // 2. Decode attestationObject (CBOR map)
  const attestationBytes = b64uDecode(response.attestationObject);
  const attestationMap = parseCborMap(attestationBytes);

  const authDataValue = attestationMap.get("authData");
  if (!(authDataValue instanceof Uint8Array)) {
    throw new Error("WebAuthn: attestationObject missing authData bytes");
  }

  // 3. Parse authenticatorData
  const authData = parseAuthenticatorData(authDataValue);

  // 4. Verify rpIdHash
  const expectedRpIdHash = await sha256(new TextEncoder().encode(rpId));
  if (!timingSafeEqual(authData.rpIdHash, expectedRpIdHash)) {
    throw new Error("WebAuthn: rpIdHash mismatch");
  }

  // 5. Check UV flag
  if (!(authData.flags & FLAG_UV)) {
    throw new Error("WebAuthn: user verification required but UV flag not set");
  }

  // 6. Ensure AT flag and credential data present
  if (
    !(authData.flags & FLAG_AT) ||
    !authData.credentialId ||
    !authData.credentialPublicKeyBytes
  ) {
    throw new Error("WebAuthn: attested credential data missing");
  }

  // 7. Import COSE key
  const { spki } = await importCoseKey(authData.credentialPublicKeyBytes);

  return {
    credentialId: b64uEncode(authData.credentialId),
    publicKeySpki: spki,
    signCount: authData.signCount,
    aaguid: authData.aaguid,
  };
}

/**
 * Convert a DER-encoded ECDSA signature (ASN.1 SEQUENCE of two INTEGERs) to the
 * raw IEEE-P1363 form (r||s, 32 bytes each for P-256) that WebCrypto's ECDSA
 * verify requires. WebAuthn ES256 assertions are DER-encoded; passing DER bytes
 * straight to crypto.subtle.verify silently fails ("signature verification
 * failed") for every passkey login.
 */
function derToRawEcdsaSignature(sig: Uint8Array): Uint8Array {
  // Already raw P1363 (no DER SEQUENCE tag) — pass through.
  if (sig.length === 64 && sig[0] !== 0x30) return sig;
  if (sig[0] !== 0x30) {
    throw new Error("WebAuthn: malformed ECDSA signature (no SEQUENCE)");
  }
  let i = 2; // SEQUENCE tag + short-form length
  if (sig[1] & 0x80) i = 2 + (sig[1] & 0x7f); // long-form length (defensive)
  const readInt = (): Uint8Array => {
    if (sig[i] !== 0x02) {
      throw new Error("WebAuthn: malformed ECDSA signature (no INTEGER)");
    }
    const len = sig[i + 1];
    const val = sig.slice(i + 2, i + 2 + len);
    i += 2 + len;
    return val;
  };
  const r = readInt();
  const s = readInt();
  const pad32 = (b: Uint8Array): Uint8Array => {
    let j = 0;
    while (j < b.length - 1 && b[j] === 0) j++; // strip DER leading zero(s)
    const t = b.subarray(j);
    const out = new Uint8Array(32);
    out.set(t.subarray(Math.max(0, t.length - 32)), Math.max(0, 32 - t.length));
    return out;
  };
  const raw = new Uint8Array(64);
  raw.set(pad32(r), 0);
  raw.set(pad32(s), 32);
  return raw;
}

export async function verifyAuthentication(
  challenge: string,
  rpId: string,
  storedSpki: string,
  storedSignCount: number,
  response: {
    clientDataJSON: string; // base64url
    authenticatorData: string; // base64url
    signature: string; // base64url
  },
): Promise<{ newSignCount: number }> {
  // 1. Decode and verify clientDataJSON
  const clientDataBytes = b64uDecode(response.clientDataJSON);
  const clientData = JSON.parse(
    new TextDecoder().decode(clientDataBytes),
  ) as Record<string, unknown>;

  if (clientData.type !== "webauthn.get") {
    throw new Error(
      `WebAuthn: unexpected clientData.type "${clientData.type}"`,
    );
  }
  if (stripPadding(String(clientData.challenge)) !== stripPadding(challenge)) {
    throw new Error("WebAuthn: challenge mismatch");
  }

  // Verify origin hostname matches rpId
  const origin = String(clientData.origin ?? "");
  const originHostname = new URL(origin).hostname;
  if (originHostname !== rpId) {
    throw new Error(
      `WebAuthn: origin hostname "${originHostname}" does not match rpId "${rpId}"`,
    );
  }

  // 2. Parse authenticatorData
  const authDataBytes = b64uDecode(response.authenticatorData);
  const authData = parseAuthenticatorData(authDataBytes);

  // 3. Verify rpIdHash
  const expectedRpIdHash = await sha256(new TextEncoder().encode(rpId));
  if (!timingSafeEqual(authData.rpIdHash, expectedRpIdHash)) {
    throw new Error("WebAuthn: rpIdHash mismatch");
  }

  // 4. Check UV flag
  if (!(authData.flags & FLAG_UV)) {
    throw new Error("WebAuthn: user verification required but UV flag not set");
  }

  // 5. Replay protection: signCount must advance (skip if either is 0)
  const newSignCount = authData.signCount;
  if (
    storedSignCount !== 0 &&
    newSignCount !== 0 &&
    newSignCount <= storedSignCount
  ) {
    throw new Error(
      `WebAuthn: signCount replay detected (stored=${storedSignCount}, received=${newSignCount})`,
    );
  }

  // 6. Import stored SPKI public key
  const spkiBytes = b64uDecode(storedSpki);
  const publicKey = await crypto.subtle.importKey(
    "spki",
    spkiBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );

  // 7. Verify ECDSA signature: sig over authData || SHA-256(clientDataJSON)
  const clientDataHash = await sha256(clientDataBytes);
  const sigBase = new Uint8Array(authDataBytes.length + clientDataHash.length);
  sigBase.set(authDataBytes, 0);
  sigBase.set(clientDataHash, authDataBytes.length);

  // WebAuthn ES256 signatures are DER-encoded; WebCrypto needs raw r||s.
  const sigBytes = derToRawEcdsaSignature(b64uDecode(response.signature));
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    sigBytes,
    sigBase,
  );

  if (!valid) {
    throw new Error("WebAuthn: signature verification failed");
  }

  return { newSignCount };
}

// ---------------------------------------------------------------------------
// Timing-safe byte comparison
// ---------------------------------------------------------------------------
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// Re-export FLAG_UP for consumers that need it (e.g. tests)
export { FLAG_UP, FLAG_UV };
