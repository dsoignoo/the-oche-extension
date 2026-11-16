import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { zipSync } from "fflate";
import { readdir } from "node:fs/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "dist", "the-oche");
await rm(out, { recursive: true, force: true });
await mkdir(join(out, "vendor"), { recursive: true });
// Explicit allowlist: no credentials, tests, development dependencies, or old
// server packages can accidentally enter the extension shared with a friend.
for (const path of ["manifest.json", "background.mjs", "auth.mjs", "stats.mjs", "history.mjs", "history-store.mjs", "insights.mjs", "analytics.mjs", "finishing.mjs", "public"])
  await cp(join(root, path), join(out, path), { recursive: true });
await cp(join(root, "node_modules/chart.js/dist/chart.umd.js"), join(out, "vendor/chart.umd.js"));
await cp(join(root, "node_modules/chart.js/LICENSE.md"), join(out, "vendor/Chart.js-LICENSE.md"));
const files = {};
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    else files[relative(out, path).replaceAll("\\", "/")] = new Uint8Array(await readFile(path));
  }
}
await collect(out);
await writeFile(join(root, "dist/the-oche-extension.zip"), zipSync(files, { level: 6 }));
console.log(`Load unpacked: ${out}`);
console.log(`Share: ${join(root, "dist/the-oche-extension.zip")}`);
