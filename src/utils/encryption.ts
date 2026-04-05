import crypto from "crypto";

let cachedKey: Buffer;
let cachedIv: Buffer;
let cachedKeySource: string;

export function getSecret(encryptionKey: string): Buffer {
  if (cachedKey && cachedKeySource === encryptionKey) {
    return cachedKey;
  }

  cachedKey = crypto.createHash("sha256").update(encryptionKey).digest();
  cachedIv = crypto.createHash("sha256").update(cachedKey).digest().subarray(0, 16);
  cachedKeySource = encryptionKey;
  return cachedKey;
}

export function encryptUrl(url: string, secret: Buffer): string {
  const cipher = crypto.createCipheriv("aes-256-cbc", secret, cachedIv);
  return Buffer.concat([cipher.update(url, "utf8"), cipher.final()]).toString("base64url");
}

export function decryptUrl(token: string, secret: Buffer): string {
  const decipher = crypto.createDecipheriv("aes-256-cbc", secret, cachedIv);
  return decipher.update(token, "base64url", "utf8") + decipher.final("utf8");
}
