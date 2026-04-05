import { CompactEncrypt } from "jose";

const value = process.argv[2];

if (!process.env.URL_ENCRYPTION_KEY) {
  throw new Error("URL_ENCRYPTION_KEY is required");
}

if (!value) {
  throw new Error("Value argument is required");
}

const secret = new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(process.env.URL_ENCRYPTION_KEY)),
);

const encrypted = await new CompactEncrypt(new TextEncoder().encode(value))
  .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
  .encrypt(secret);

console.log(`input: ${value}`);
console.log(`encrypted: ${encrypted}`);
console.log(`encoded: ${encodeURIComponent(encrypted)}`);
