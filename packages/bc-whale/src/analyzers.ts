import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type EffectiveConfig, workDir } from "./config.js";
import type { RepoModel } from "./repo.js";

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export function resolveAnalyzers(repo: RepoModel, cfg: EffectiveConfig, compilerFolder: string) {
  const provisioned = join(workDir(repo), "analyzers");
  const bin = /^(win32|linux|darwin)$/i.test(basename(compilerFolder)) ? dirname(compilerFolder) : compilerFolder;
  const compilerFolders = [...new Set([compilerFolder, bin, join(bin, "Analyzers")])];
  const resolved: { configured: string; path: string; sha256: string }[] = [];
  const missing: string[] = [];
  for (const configured of cfg.customAnalyzers ?? []) {
    const placeholder = /\$\{analyzerFolder\}/i.test(configured);
    const name = basename(configured.replace(/\$\{analyzerFolder\}[\\/]?/ig, ""));
    const candidates = [
      ...(!placeholder ? [configured] : []),
      join(provisioned, name),
      ...compilerFolders.map((folder) => join(folder, name)),
    ];
    const path = candidates.find((p) => existsSync(p));
    if (!path) missing.push(configured);
    else if (!resolved.some((r) => r.path.toLowerCase() === path.toLowerCase())) resolved.push({ configured, path, sha256: sha256(path) });
  }
  return { succeeded: missing.length === 0, resolved, missing, hint: missing.length ? "For ALCops, use the Arthurvdv.alcops VS Code extension and run 'ALCops: Install', or run analyzers prepare --source <trusted local suite folder>. Other missing analyzers must be installed separately. Configured analyzers may not be skipped." : undefined };
}

/** Copy only a locally selected suite, keeping companion assemblies beside the analyzers. */
export function provisionAnalyzers(repo: RepoModel, source: string) {
  const names = readdirSync(source).filter((n) => /^ALCops\..+\.(dll|deps\.json)$/i.test(n));
  if (!names.some((n) => n.endsWith(".dll"))) throw new Error(`No ALCops assemblies in ${source}`);
  const destination = workDir(repo, "analyzers");
  const files = names.map((name) => {
    const from = join(source, name), to = join(destination, name);
    const hash = sha256(from);
    copyFileSync(from, to);
    if (sha256(to) !== hash) throw new Error(`Analyzer copy hash mismatch: ${name}`);
    return { name, sha256: hash };
  });
  const manifest = { source, files, preparedAt: new Date().toISOString() };
  writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { succeeded: true, destination, ...manifest, note: "Availability is verified. Compiler execution validates runtime compatibility." };
}
