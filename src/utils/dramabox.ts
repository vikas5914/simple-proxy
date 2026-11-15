import { createDecipheriv, createHash } from "node:crypto";

// DramaBox "*.encrypt.mp4" files keep a plain `moov`, but the whole 16-byte blocks of every
// sample are AES-128-ECB encrypted. The sample key is wrapped in the `PrivateKeyUri` metadata
// item and opens with a per-host master key, ported from DramaTip's player bundle (via reelflux).
const MASTER_KEYS = [
  { host: /(^|\.)dramaboxdb\.com$/i, master: "6eba09062155dcd2" },
  { host: /(^|\.)storeel\.app$/i, master: "d240c6a9a2d68888" },
];

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const UPSTREAM_TIMEOUT_MS = 15_000;
const HEAD_BYTES = 64 * 1024;
const MAX_MOOV_BYTES = 16 * 1024 * 1024;
const META_CACHE_LIMIT = 64;
// The body is streamed in pieces this size, so a seek or a closed tab stops the upstream reads.
const PIECE_BYTES = 2 * 1024 * 1024;

const decoder = new TextDecoder();

export class DramaBoxError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function masterKey(url: string): string | null {
  try {
    const u = new URL(url);
    const entry = MASTER_KEYS.find((k) => k.host.test(u.hostname));
    if (!entry) return null;
    return /encrypt\.mp4$/i.test(u.pathname) || u.searchParams.has("etavirp_nuyila")
      ? entry.master
      : null;
  } catch {
    return null;
  }
}

export function isDramaBoxEncrypted(url: string): boolean {
  return masterKey(url) !== null;
}

function md5Middle(text: string): Buffer {
  return Buffer.from(createHash("md5").update(text).digest("hex").slice(8, 24));
}

function aesCbcDecrypt(key: Buffer, iv: Buffer, data: Buffer): string {
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function unwrapSampleKey(wrapped: string, master: string): Buffer {
  const masterBytes = Buffer.from(master);
  const envelope = JSON.parse(
    aesCbcDecrypt(masterBytes, masterBytes, Buffer.from(wrapped, "base64")),
  );
  const { ClientRand, ServerRand, PlainText } = envelope ?? {};
  if (![ClientRand, ServerRand, PlainText].every((v) => typeof v === "string")) {
    throw new DramaBoxError(502, "malformed DramaBox key envelope");
  }
  const clientKey = md5Middle(ClientRand);
  const serverRand = aesCbcDecrypt(clientKey, clientKey, Buffer.from(ServerRand, "base64"));
  const sessionKey = md5Middle(ClientRand + serverRand);
  return Buffer.from(
    aesCbcDecrypt(sessionKey, clientKey, Buffer.from(PlainText, "base64")),
    "base64",
  );
}

type Box = { start: number; end: number; body: number };

function boxType(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
}

function findChild(view: DataView, bytes: Uint8Array, from: number, to: number, type: string) {
  let at = from;
  while (at + 8 <= to) {
    const size = view.getUint32(at);
    if (size < 8) return null;
    if (boxType(bytes, at) === type)
      return { start: at, end: Math.min(at + size, to), body: at + 8 };
    at += size;
  }
  return null;
}

function findChildren(view: DataView, bytes: Uint8Array, box: Box, type: string): Box[] {
  const found: Box[] = [];
  let at = box.body;
  while (at + 8 <= box.end) {
    const size = view.getUint32(at);
    if (size < 8) break;
    if (boxType(bytes, at) === type) {
      found.push({ start: at, end: Math.min(at + size, box.end), body: at + 8 });
    }
    at += size;
  }
  return found;
}

// moov/udta/meta holds a `keys` box (names) and an `ilst` box whose items point at them by index.
function readPrivateKeyUri(moov: Buffer): string | null {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const keysAt = moov.indexOf("keys") - 4;
  if (keysAt < 0) return null;
  const keysSize = view.getUint32(keysAt);
  if (keysSize <= 20 || keysSize >= 10_000) return null;
  const names: string[] = [];
  let at = keysAt + 16;
  for (let n = view.getUint32(keysAt + 12); n > 0; n--) {
    const size = view.getUint32(at);
    if (size < 8) break;
    names.push(decoder.decode(moov.subarray(at + 8, at + size)));
    at += size;
  }

  const ilstAt = moov.indexOf("ilst", keysAt) - 4;
  if (ilstAt < 0) return null;
  const ilstEnd = ilstAt + view.getUint32(ilstAt);
  for (at = ilstAt + 8; at + 8 < ilstEnd; ) {
    const size = view.getUint32(at);
    if (size < 8) break;
    const keyIndex = view.getUint32(at + 4);
    const dataSize = view.getUint32(at + 8);
    if (
      boxType(moov, at + 8) === "data" &&
      dataSize > 16 &&
      (names[keyIndex - 1] ?? "").includes("PrivateKeyUri")
    ) {
      return decoder.decode(moov.subarray(at + 24, at + 8 + dataSize)).trim();
    }
    at += size;
  }
  return null;
}

type Region = { offset: number; length: number };

// Each sample's file offset and size, from the stco/stsc/stsz tables of one track.
function trackSamples(view: DataView, bytes: Uint8Array, stbl: Box): Region[] {
  const stsz = findChild(view, bytes, stbl.body, stbl.end, "stsz");
  const stco = findChild(view, bytes, stbl.body, stbl.end, "stco");
  const co64 = findChild(view, bytes, stbl.body, stbl.end, "co64");
  const stsc = findChild(view, bytes, stbl.body, stbl.end, "stsc");
  if (!stsz || !stsc || (!stco && !co64)) return [];

  const fixedSize = view.getUint32(stsz.body + 4);
  const sampleCount = view.getUint32(stsz.body + 8);
  const sizeAt = (i: number) => fixedSize || view.getUint32(stsz.body + 12 + 4 * i);

  const chunkOffsets: number[] = [];
  if (stco) {
    const n = view.getUint32(stco.body + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(view.getUint32(stco.body + 8 + 4 * i));
  } else if (co64) {
    const n = view.getUint32(co64.body + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(Number(view.getBigUint64(co64.body + 8 + 8 * i)));
  }

  const runs: { firstChunk: number; perChunk: number }[] = [];
  const runCount = view.getUint32(stsc.body + 4);
  for (let i = 0; i < runCount; i++) {
    runs.push({
      firstChunk: view.getUint32(stsc.body + 8 + 12 * i),
      perChunk: view.getUint32(stsc.body + 12 + 12 * i),
    });
  }

  const samples: Region[] = [];
  let sample = 0;
  let run = 0;
  for (let chunk = 0; chunk < chunkOffsets.length && sample < sampleCount; chunk++) {
    while (run + 1 < runs.length && chunk + 1 >= runs[run + 1].firstChunk) run++;
    let offset = chunkOffsets[chunk];
    for (let i = 0; i < (runs[run]?.perChunk ?? 1) && sample < sampleCount; i++) {
      const size = sizeAt(sample);
      samples.push({ offset, length: size });
      offset += size;
      sample++;
    }
  }
  return samples;
}

export type DramaBoxMeta = {
  size: number;
  key: Buffer;
  // Encrypted spans (each sample's whole blocks), sorted by offset.
  offsets: Float64Array;
  lengths: Uint32Array;
};

async function fetchRange(url: string, start: number, end: number): Promise<Response> {
  const res = await globalThis.fetch(url, {
    headers: { "User-Agent": UA, Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (res.status !== 206) {
    await res.body?.cancel();
    throw new DramaBoxError(res.status === 200 ? 502 : res.status, `upstream ${res.status}`);
  }
  return res;
}

async function readRange(url: string, start: number, end: number): Promise<Buffer> {
  const bytes = Buffer.from(await (await fetchRange(url, start, end)).arrayBuffer());
  if (bytes.length !== end - start + 1) {
    throw new DramaBoxError(502, `upstream sent ${bytes.length} bytes for a ranged read`);
  }
  return bytes;
}

async function loadMeta(url: string, master: string): Promise<DramaBoxMeta> {
  const headRes = await fetchRange(url, 0, HEAD_BYTES - 1);
  const size = Number(headRes.headers.get("Content-Range")?.match(/\/(\d+)$/)?.[1]);
  if (!Number.isFinite(size) || size <= 0) {
    await headRes.body?.cancel();
    throw new DramaBoxError(502, "upstream sent no Content-Range total");
  }
  const head = Buffer.from(await headRes.arrayBuffer());
  const headerAt = async (pos: number) =>
    pos + 16 <= head.length
      ? head.subarray(pos, pos + 16)
      : readRange(url, pos, Math.min(pos + 15, size - 1));

  // moov normally follows ftyp; when mdat comes first, only box headers are read past it.
  let at = 0;
  let moovSize = 0;
  for (let boxes = 0; boxes < 16 && at + 8 <= size; boxes++) {
    const header = await headerAt(at);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const small = view.getUint32(0);
    const boxSize = small === 1 ? Number(view.getBigUint64(8)) : small === 0 ? size - at : small;
    if (boxType(header, 0) === "moov") {
      moovSize = boxSize;
      break;
    }
    if (boxSize < 8) break;
    at += boxSize;
  }
  if (moovSize < 8 || moovSize > MAX_MOOV_BYTES) throw new DramaBoxError(502, "no moov box");

  const moov =
    at + moovSize <= head.length
      ? head.subarray(at, at + moovSize)
      : await readRange(url, at, at + moovSize - 1);
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);

  const wrapped = readPrivateKeyUri(moov);
  if (!wrapped) throw new DramaBoxError(502, "no PrivateKeyUri in moov");
  const key = unwrapSampleKey(wrapped, master);
  if (key.length !== 16) throw new DramaBoxError(502, "DramaBox sample key is not 16 bytes");

  const moovBox: Box = { start: 0, end: moov.length, body: 8 };
  const regions: Region[] = [];
  for (const trak of findChildren(view, moov, moovBox, "trak")) {
    const mdia = findChild(view, moov, trak.body, trak.end, "mdia");
    const minf = mdia && findChild(view, moov, mdia.body, mdia.end, "minf");
    const stbl = minf && findChild(view, moov, minf.body, minf.end, "stbl");
    if (!stbl) continue;
    for (const s of trackSamples(view, moov, stbl)) {
      const length = s.length & ~15;
      if (length > 0) regions.push({ offset: s.offset, length });
    }
  }
  regions.sort((a, b) => a.offset - b.offset);

  return {
    size,
    key,
    offsets: Float64Array.from(regions, (r) => r.offset),
    lengths: Uint32Array.from(regions, (r) => r.length),
  };
}

const metaCache = new Map<string, Promise<DramaBoxMeta>>();

// Signed URLs for one file differ only in their query, so the cache keys on the path.
export function getDramaBoxMeta(url: string): Promise<DramaBoxMeta> {
  const master = masterKey(url);
  if (!master) return Promise.reject(new DramaBoxError(400, "not a DramaBox encrypted mp4"));
  const u = new URL(url);
  const cacheKey = `${u.host}${u.pathname}`;
  const cached = metaCache.get(cacheKey);
  if (cached) return cached;
  const pending = loadMeta(url, master);
  pending.catch(() => metaCache.delete(cacheKey));
  if (metaCache.size >= META_CACHE_LIMIT) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== undefined) metaCache.delete(oldest);
  }
  metaCache.set(cacheKey, pending);
  return pending;
}

// Index of the last region whose offset is <= pos, or -1.
function regionAt(meta: DramaBoxMeta, pos: number): number {
  let lo = 0;
  let hi = meta.offsets.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (meta.offsets[mid] <= pos) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

// Widen [start, end] so it never cuts an encrypted block in half.
function alignRange(meta: DramaBoxMeta, start: number, end: number): [number, number] {
  let alignedStart = start;
  const first = regionAt(meta, start);
  if (first >= 0 && start < meta.offsets[first] + meta.lengths[first]) {
    alignedStart = meta.offsets[first] + ((start - meta.offsets[first]) & ~15);
  }
  let alignedEnd = end;
  const last = regionAt(meta, end);
  if (last >= 0 && end < meta.offsets[last] + meta.lengths[last]) {
    alignedEnd = meta.offsets[last] + ((end - meta.offsets[last]) | 15);
  }
  return [alignedStart, alignedEnd];
}

// Decrypts, in place, the encrypted blocks inside `bytes`, which holds the file from `start`.
// `start` and `start + bytes.length` must come from alignRange.
function decryptInPlace(meta: DramaBoxMeta, bytes: Buffer, start: number): void {
  const end = start + bytes.length;
  const decipher = createDecipheriv("aes-128-ecb", meta.key, null).setAutoPadding(false);
  for (let i = Math.max(regionAt(meta, start), 0); i < meta.offsets.length; i++) {
    if (meta.offsets[i] >= end) break;
    const from = Math.max(meta.offsets[i], start);
    const to = Math.min(meta.offsets[i] + meta.lengths[i], end);
    if (to <= from) continue;
    const span = bytes.subarray(from - start, to - start);
    span.set(decipher.update(span));
  }
  decipher.final();
}

async function decryptedRange(
  url: string,
  meta: DramaBoxMeta,
  start: number,
  end: number,
): Promise<Buffer> {
  const [alignedStart, alignedEnd] = alignRange(meta, start, end);
  const bytes = await readRange(url, alignedStart, alignedEnd);
  decryptInPlace(meta, bytes, alignedStart);
  return bytes.subarray(start - alignedStart, end - alignedStart + 1);
}

// The plain bytes [start, end] of the file, read and decrypted one piece at a time.
export function decryptedStream(
  url: string,
  meta: DramaBoxMeta,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  let next = start;
  return new ReadableStream({
    async pull(controller) {
      if (next > end) {
        controller.close();
        return;
      }
      const pieceEnd = Math.min(end, next + PIECE_BYTES - 1);
      controller.enqueue(await decryptedRange(url, meta, next, pieceEnd));
      next = pieceEnd + 1;
    },
  });
}
