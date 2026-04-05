import crypto from "crypto";

const key = crypto.createHash("sha256").update(process.env.URL_ENCRYPTION_KEY).digest();
const iv = crypto.createHash("sha256").update(key).digest().subarray(0, 16);

const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
const decrypted = decipher.update(process.argv[2], "base64url", "utf8") + decipher.final("utf8");

console.log(`input: ${process.argv[2]}`);
console.log(`decrypted: ${decrypted}`);
