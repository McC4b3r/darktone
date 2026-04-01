import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../dist");
const assetsDir = path.join(distDir, "assets");
const workletAssetPath = path.join(distDir, "audio-worklet.js");

function fail(message) {
  throw new Error(`Worklet build verification failed: ${message}`);
}

if (!existsSync(distDir)) {
  fail(`dist directory was not found at ${distDir}`);
}

if (!existsSync(workletAssetPath)) {
  fail(`expected ${path.relative(process.cwd(), workletAssetPath)} to exist`);
}

if (!existsSync(assetsDir)) {
  fail(`assets directory was not found at ${assetsDir}`);
}

const assetNames = readdirSync(assetsDir);
const tsWorkletAssets = assetNames.filter((name) => /^audio-worklet-.*\.ts$/u.test(name));
if (tsWorkletAssets.length > 0) {
  fail(`unexpected TypeScript worklet assets found: ${tsWorkletAssets.join(", ")}`);
}

const bundleNames = assetNames.filter((name) => /^index-.*\.js$/u.test(name));
if (bundleNames.length === 0) {
  fail("could not find a built application bundle in dist/assets");
}

const bundleContents = bundleNames.map((name) =>
  readFileSync(path.join(assetsDir, name), "utf8"),
);

if (!bundleContents.some((content) => content.includes("audio-worklet.js"))) {
  fail("built bundle does not reference audio-worklet.js");
}

if (
  bundleContents.some(
    (content) =>
      content.includes("audio-worklet.ts") ||
      /audio-worklet-[^"]+\.ts/u.test(content),
  )
) {
  fail("built bundle still references a TypeScript worklet module");
}

console.info("Verified packaged playback worklet asset output.");
