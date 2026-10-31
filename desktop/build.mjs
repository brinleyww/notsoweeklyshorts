// node desktop/build.mjs
// Everything it downloads and makes stays in ../nsws-desktop-build: the repo root is published as site assets.
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";

const ELECTRON = "45.2.0", PACKAGER = "20.3.0";
const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.resolve(here, "../../nsws-desktop-build");
fs.mkdirSync(work, { recursive: true });
if (!fs.existsSync(path.join(work, "package.json"))) fs.writeFileSync(path.join(work, "package.json"), '{"private":true}');
execSync(`npm install --save-exact --no-audit --no-fund electron@${ELECTRON} @electron/packager@${PACKAGER}`, { cwd: work, stdio: "inherit" });

const require = createRequire(path.join(work, "package.json"));
const { packager } = await import(pathToFileURL(require.resolve("@electron/packager")).href);
const [out] = await packager({
    dir: here,
    out: path.join(work, "dist"),
    platform: "win32",
    arch: "x64",
    electronVersion: ELECTRON,
    executableName: "NSWS",
    icon: path.join(here, "icon.ico"),
    ignore: [/^\/build\.mjs$/],
    overwrite: true,
    asar: true
});
console.log("built", out);
