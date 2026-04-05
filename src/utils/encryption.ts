import { CompactEncrypt, compactDecrypt } from "jose";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedSecret: Uint8Array | null = null;
let cachedKeySource: string | undefined;

export async function getSecret(encryptionKey: string): Promise<Uint8Array> {
  if (cachedSecret && cachedKeySource === encryptionKey) {
    return cachedSecret;
  }
  cachedSecret = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(encryptionKey)),
  );
  cachedKeySource = encryptionKey;
  return cachedSecret;
}

export async function encryptUrl(url: string, secret: Uint8Array): Promise<string> {
  return new CompactEncrypt(encoder.encode(url))
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .encrypt(secret);
}

export async function decryptUrl(token: string, secret: Uint8Array): Promise<string> {
  const { plaintext } = await compactDecrypt(token, secret);
  return decoder.decode(plaintext);
}
