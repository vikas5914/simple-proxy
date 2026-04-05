import crypto from "crypto";

const key = crypto.createHash("sha256").update(process.env.URL_ENCRYPTION_KEY).digest();
const iv = crypto.createHash("sha256").update(key).digest().subarray(0, 16);

const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
const encrypted = Buffer.concat([cipher.update(process.argv[2], "utf8"), cipher.final()]).toString(
  "base64url",
);

console.log(`input: ${process.argv[2]}`);
console.log(`encrypted: ${encrypted}`);
console.log(`encoded: ${encodeURIComponent(encrypted)}`);
