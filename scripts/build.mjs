import { build } from "esbuild";
import { copyFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const packages = [
  { name: "bc-whale", entryPoints: ["src/cli.ts", "src/mcp.ts", "src/profile-analysis-worker.ts"] },
  { name: "whale", entryPoints: ["src/cli.ts", "src/mcp.ts"], catalog: true },
];

async function bundle({ name, entryPoints, catalog }) {
  const root = join(repository, "packages", name);
  const outdir = join(root, "runtime");
  try {
    for (const file of readdirSync(outdir)) {
      if (/^[\w.-]+\.js(?:\.LEGAL\.txt)?$/.test(file)) unlinkSync(join(outdir, file));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const result = await build({
    absWorkingDir: root,
    entryPoints,
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    mainFields: ["module", "main"],
    target: "node22",
    minify: true,
    legalComments: "external",
    metafile: true,
    banner: { js: 'import { createRequire as __bcWhaleCreateRequire } from "node:module"; const require = __bcWhaleCreateRequire(import.meta.url);' },
  });

  const dependencies = [...new Set(Object.keys(result.metafile.inputs)
    .map((input) => /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1])
    .filter(Boolean))].sort();
  const notices = dependencies.map((dependency) => {
    const directory = join(root, "node_modules", dependency);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const files = readdirSync(directory).filter((file) => /^(licen[cs]e|notice)(\.(md|txt))?$/i.test(file)).sort();
    if (!files.length && !existsSync(join(directory, "LICENSE"))) {
      throw new Error(`Missing distribution license/notice for bundled dependency ${dependency}`);
    }
    return [`# ${dependency}@${manifest.version} (${manifest.license ?? "see license"})`,
      ...files.map((file) => readFileSync(join(directory, file), "utf8").replace(/\r\n/g, "\n")),
    ].join("\n\n");
  });
  writeFileSync(join(outdir, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n---\n\n") + "\n");
  if (catalog) copyFileSync(join(repository, "catalog.json"), join(outdir, "catalog.json"));
}

for (const entry of packages) await bundle(entry);
