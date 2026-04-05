import { compactDecrypt } from "jose";

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

const decrypted = new TextDecoder().decode((await compactDecrypt(value, secret)).plaintext);

console.log(`input: ${value}`);
console.log(`decrypted: ${decrypted}`);
