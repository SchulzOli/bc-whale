import { build } from "esbuild";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../packages/bc-whale/", import.meta.url));
const outdir = join(root, "runtime");

try {
  for (const name of readdirSync(outdir)) {
    if (/^[\w.-]+\.js(?:\.LEGAL\.txt)?$/.test(name)) unlinkSync(join(outdir, name));
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/cli.ts", "src/mcp.ts", "src/profile-analysis-worker.ts"],
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

const packages = [...new Set(Object.keys(result.metafile.inputs)
  .map((input) => /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1])
  .filter(Boolean))].sort();
const notices = packages.map((name) => {
  const directory = join(root, "node_modules", name);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const files = readdirSync(directory).filter((file) => /^(licen[cs]e|notice)(\.(md|txt))?$/i.test(file)).sort();
  if (!files.length && !existsSync(join(directory, "LICENSE"))) {
    throw new Error(`Missing distribution license/notice for bundled dependency ${name}`);
  }
  return [`# ${name}@${manifest.version} (${manifest.license ?? "see license"})`,
    ...files.map((file) => readFileSync(join(directory, file), "utf8").replace(/\r\n/g, "\n")),
  ].join("\n\n");
});
writeFileSync(join(outdir, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n---\n\n") + "\n");
