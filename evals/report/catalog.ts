import assert from "node:assert/strict";

export const FAMILIES = ["module", "pilot", "sdk-read-write", "sdk-live", "sdk-context", "sdk-lifecycle", "sdk-transport", "sdk-context-live", "sdk-recovery", "sdk-supervision", "sdk-supervision-live"] as const;
export type Family = typeof FAMILIES[number];
export interface Selection { id: string; family: Family; directory: string; manifestSha256: string; treeSha256: string; }
export interface Catalog { schemaVersion: 1; kind: "phase5-evidence-selection"; entries: Selection[]; }
const roots: Record<Family, string> = {
  module: "evals", pilot: "live-pilots", "sdk-read-write": "sdk-ablations", "sdk-live": "sdk-live",
  "sdk-context": "sdk-context", "sdk-lifecycle": "sdk-context", "sdk-transport": "sdk-context-transport",
  "sdk-context-live": "sdk-context-live", "sdk-recovery": "sdk-recovery-races",
  "sdk-supervision": "sdk-supervision",
  "sdk-supervision-live": "sdk-supervision-live",
};
export const hash = (v: unknown): void => { assert.ok(typeof v === "string" && /^[a-f0-9]{64}$/.test(v), "REPORT_HASH"); };
export const token = (v: unknown): string => { assert.ok(typeof v === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(v), "REPORT_TOKEN"); return v; };
export function validateCatalog(value: unknown): Catalog {
  const c = value as Catalog;
  assert.ok(c && typeof c === "object" && !Array.isArray(c), "REPORT_CATALOG");
  assert.deepEqual(Object.keys(c).sort(), ["entries", "kind", "schemaVersion"]);
  assert.equal(c.schemaVersion, 1); assert.equal(c.kind, "phase5-evidence-selection");
  assert.ok(Array.isArray(c.entries) && c.entries.length > 0 && c.entries.length <= 64);
  for (const e of c.entries) {
    assert.deepEqual(Object.keys(e).sort(), ["directory", "family", "id", "manifestSha256", "treeSha256"]);
    token(e.id); assert.ok(FAMILIES.includes(e.family)); hash(e.manifestSha256); hash(e.treeSha256);
    assert.ok(new RegExp("^artifacts/harness/" + roots[e.family] + "/[A-Za-z0-9_-]+$").test(e.directory), "REPORT_BATCH_PATH");
  }
  for (const field of ["id", "directory", "manifestSha256"] as const)
    assert.equal(new Set(c.entries.map(e => e[field])).size, c.entries.length, "REPORT_DUPLICATE_BATCH");
  return c;
}

// Explicit historical selection, including the failed pilot. No newest/pass-only
// discovery and no claim that representative dry runs cover every fault probe.
export const catalog: Catalog = validateCatalog({
  schemaVersion: 1, kind: "phase5-evidence-selection", entries: [
    { id: "module-matrix", family: "module", directory: "artifacts/harness/evals/offline-eOyK60", manifestSha256: "e1e173c5246c24e578d6013d5a6c354f846a1838b566960fc5715e7a02992e68", treeSha256: "a1220000afde34cb0a30bcbaa2bd80217c49a7b0a26343e973fd565c55fb0c16" },
    { id: "pilot-first-failed", family: "pilot", directory: "artifacts/harness/live-pilots/live-CwHPbD", manifestSha256: "932c097373b908e4bac720a47c5db666e2a10cd01eeefb95e6640b013abec3e5", treeSha256: "9bb64a7d3555953f0f81dbb310863ec0a2964e121fb8ab7e5b460554f4ec4c75" },
    { id: "pilot-second", family: "pilot", directory: "artifacts/harness/live-pilots/live-mHOnDl", manifestSha256: "f131737c6669d12645e1936b39d75adf448c311316e00adb71b60afee381848d", treeSha256: "86ce7ab6cb7821c44c7bdcc8b3278f263627f984c30d77f55fdbb4315fb7d693" },
    { id: "s1-offline", family: "sdk-read-write", directory: "artifacts/harness/sdk-ablations/sdk-s1-IRrezl", manifestSha256: "d1af61d74e423abca0e548dec9fb92950d75a37138709a3cb413ab89299f9f92", treeSha256: "8d094b80184115809621a8757e0fd6ca276a91d9ea06d7aa529fccf833d6d819" },
    { id: "s2-dry-readback", family: "sdk-live", directory: "artifacts/harness/sdk-live/s2-dry-mQwGip", manifestSha256: "1bc1f84e93b3758eb3bb896f4c9827a3240a1f4a007abe9d86165f1afbdd3f22", treeSha256: "78792bc3707c08c69cabd5bbc70c8aac7270975b3eec447779e57d1d871634d5" },
    { id: "s2-live", family: "sdk-live", directory: "artifacts/harness/sdk-live/s2-live-RGcvnD", manifestSha256: "470d9fe6e553df8321362a8837923493aad6c8a9dc7a96a06c1224b47eba2d58", treeSha256: "813d18bda6c942954d851f4e575dfd3379967f66498bc80b4261bacdee65c785" },
    { id: "s3-context", family: "sdk-context", directory: "artifacts/harness/sdk-context/s3-offline-L8cMsW", manifestSha256: "fd1459faa1363d169954ba7c6549e69bdd51fb556758cbbfcb0e7e13a6fab8c7", treeSha256: "7b122112d0992de2561184bbb202f730dd2dc6308946b9873fe852bed7b683b6" },
    { id: "s3-lifecycle", family: "sdk-lifecycle", directory: "artifacts/harness/sdk-context/s3-lifecycle-b8USvY", manifestSha256: "00a8069c47b5c6fada72279acac0a67de4097bfb13a5eb54c2cfcb8cadfd958a", treeSha256: "89dd2531f59cfa9183ce98d6499f5395dde62aec0e5bf0b8888f3e5bb63a3f61" },
    { id: "s3-transport-split", family: "sdk-transport", directory: "artifacts/harness/sdk-context-transport/s3-transport-sYv5iO", manifestSha256: "169880a67c40ed40b6eb0614eecef0be20e6c741f4318edf97b6fe22f396b09a", treeSha256: "3d7357d65b51343e83b494ff8676c2270afd0511db5d173494a1bc1fbb395b08" },
    { id: "s3-dry-readback", family: "sdk-context-live", directory: "artifacts/harness/sdk-context-live/s3-dry-0jsA0Z", manifestSha256: "9b0f999e162472930b41e03bdae35218900a7a7b187c3fd97e5b419114f776ef", treeSha256: "cb035028cbbde86d8e66e291d0c53e5ee6c2f0aff7fc25d2d5dd182f773ade1b" },
    { id: "s3-live", family: "sdk-context-live", directory: "artifacts/harness/sdk-context-live/s3-live-t6GSPA", manifestSha256: "4afa54958f6ba24454a49453da40a8c40a014951f2a966e1a1b70ce04a159d86", treeSha256: "d99ab8096e5f47074216e8158fac20f913217258837ccbf3e60b7357899a37b6" },
    { id: "s3-recovery-races", family: "sdk-recovery", directory: "artifacts/harness/sdk-recovery-races/s3-races-ow4RXU", manifestSha256: "92da2b35260ccb5002035c7f177fd212a44a958a9ba772bc9a016995e7d92823", treeSha256: "7fa7fddff8c1280949165d29300aafb9f3987d521d6215940ebb262c5aa8d56d" },
    { id: "s4-supervision", family: "sdk-supervision", directory: "artifacts/harness/sdk-supervision/s4-offline-zg1l2J", manifestSha256: "1ba6406ce608e4d1241689d943dc08726330e900cf1c882142578f5914be1151", treeSha256: "b79940ad49202242793339503c0180df188884b7ac03e9ce221ce82e8729b217" },
    { id: "s4-live-first-incomplete", family: "sdk-supervision-live", directory: "artifacts/harness/sdk-supervision-live/s4-live-orlzII", manifestSha256: "b0c02af70815e17a5e75e9e915b2893d45366b8ba04cc6ed3814f5800d34aa5c", treeSha256: "91c230c8dc573c1c956bba8908b6a399c115e4d469655467cc073084be3ad84b" },
    { id: "s4-live-8x72", family: "sdk-supervision-live", directory: "artifacts/harness/sdk-supervision-live/s4-live-FJMrVf", manifestSha256: "963c576f10a383cfe3e489a99dd2cf6070a88714fea2c60d1d85a3d76fc317c1", treeSha256: "a5f302c1de356320b33f0041584e07846d35b3b5b09879964b7ff4ea3f072e9f" },
  ],
});
