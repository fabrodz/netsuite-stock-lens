// Build + zip the extension into dist/netsuite-stock-lens-{version}.zip.
// `pnpm release` calls this. WXT's `wxt zip` already produces a zip
// inside `.output/`; this script runs the build, locates that artifact,
// and copies it to a stable `dist/` path so CI / store-upload steps
// don't have to know the WXT internal layout.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`package.json version "${version}" is not semver. Bump it before releasing.`);
}

console.log(`Building NetSuite Stock Lens v${version}…`);
execSync("pnpm exec wxt build", { cwd: root, stdio: "inherit" });
execSync("pnpm exec wxt zip", { cwd: root, stdio: "inherit" });

// WXT writes the zip as `<name>-<version>-chrome.zip` inside `.output/`.
// We don't hardcode the filename because WXT has renamed the pattern
// across versions; instead we pick the newest `.zip` in `.output/`.
const outputDir = resolve(root, ".output");
const zips = readdirSync(outputDir)
  .filter((name) => name.endsWith(".zip"))
  .map((name) => ({ name, mtime: statSync(resolve(outputDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (zips.length === 0) {
  throw new Error("wxt zip did not produce any .zip file in .output/");
}

const sourceZip = resolve(outputDir, zips[0].name);
const distDir = resolve(root, "dist");
mkdirSync(distDir, { recursive: true });
const destZip = resolve(distDir, `netsuite-stock-lens-${version}.zip`);
copyFileSync(sourceZip, destZip);

console.log("");
console.log(`  Built:    ${sourceZip}`);
console.log(`  Release:  ${destZip}`);
console.log("");
console.log("Upload the release zip at https://chrome.google.com/webstore/devconsole.");
