import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { resolveAltool, runAltool } from "./altool.js";
import { resolveAnalyzers } from "./analyzers.js";
import { build } from "./build.js";
import { loadConfig, resolveTargetName, USER_DIR, workDir } from "./config.js";
import { publish, runTests, type TestResult } from "./deploy.js";
import { inspectContainer, invokeInContainer } from "./docker.js";
import { silentLogger, type Logger } from "./exec.js";
import { captureInputs, type InputSnapshot } from "./loop.js";
import { appFileName, loadRepo, selectProjects } from "./repo.js";
import { downloadSymbols, outputDir } from "./symbols.js";
import { resolveConnection, type Connection } from "./targets.js";
import { assertInstalledApps, assertTestSelection, assertUpgradeApps, runValidationStages, type StageResult, type ValidationApp } from "./validation.js";

export interface LifecycleOptions {
  repo?: string;
  baselineRepo: string;
  projects: string[];
  target: string;
  company?: string;
  companies?: string[];
  baselinePackages?: { file: string; sha256: string }[];
  failOn?: "error" | "warning";
  seedCodeunits: string[];
  seedMethods: string[];
  verifyCodeunits: string[];
  verifyMethods: string[];
  authorizedDisposableTarget: boolean;
  timeoutMs?: number;
  log?: Logger;
}

function requiredList(values: string[], name: string) {
  if (!values?.length || values.some((v) => !v.trim() || v.includes("*"))) {
    throw new Error(`${name} requires explicit nonempty selectors without wildcards.`);
  }
}

function testEvidence(result: TestResult): StageResult {
  const complete = result.succeeded && result.projects.length > 0 && result.projects.every((p) =>
    p.succeeded && p.methods > 0 && p.passed === p.methods && p.failed === 0 && p.skipped === 0);
  return {
    status: complete ? "passed" : "failed",
    reason: complete ? undefined : "All selected seed/verification methods must execute and pass without skipped tests.",
    evidence: result,
  };
}

/** An explicit disposable-target exercise, not a deployment or rollback command. */
export async function validateLifecycle(o: LifecycleOptions) {
  if (o.authorizedDisposableTarget !== true) throw new Error("Explicit authorizedDisposableTarget acknowledgement is required.");
  if (!o.target?.trim()) throw new Error("Explicit target and dedicated company are required.");
  if (o.company !== undefined && o.companies !== undefined) throw new Error("Choose company or companies, not both.");
  const companies = o.companies ?? (o.company !== undefined ? [o.company] : []);
  if (!companies.length || companies.some((c) => !c.trim() || c !== c.trim()) ||
      new Set(companies.map((c) => c.toLowerCase())).size !== companies.length) {
    throw new Error("Explicit unique dedicated company names are required.");
  }
  const failOn = o.failOn ?? "warning";
  if (failOn !== "error" && failOn !== "warning") throw new Error("Validation failOn must be error or warning.");
  if (o.baselinePackages !== undefined && (!o.baselinePackages.length || o.baselinePackages.some((p) =>
    !isAbsolute(p.file) || !/\.app$/i.test(p.file) || !/^[a-f0-9]{64}$/i.test(p.sha256)))) {
    throw new Error("Released baseline packages require absolute .app paths and SHA-256 hashes.");
  }
  for (const [name, values] of Object.entries({
    projects: o.projects, seedCodeunits: o.seedCodeunits, seedMethods: o.seedMethods,
    verifyCodeunits: o.verifyCodeunits, verifyMethods: o.verifyMethods,
  })) requiredList(values, name);
  const log = o.log ?? silentLogger;
  const candidate = loadRepo(o.repo ?? process.env.BC_WHALE_REPO ?? process.cwd());
  const baseline = loadRepo(o.baselineRepo);
  if (realpathSync(candidate.root).toLowerCase() === realpathSync(baseline.root).toLowerCase()) {
    throw new Error("Baseline and candidate must be distinct repository roots; copy fixtures outside a shared Git root.");
  }
  const cfg = loadConfig(candidate);
  const oldCfg = loadConfig(baseline);
  const { target } = resolveTargetName(cfg, o.target);
  if (target.type === "cloud" && target.environmentType === "Production") throw new Error("Production targets are forbidden for lifecycle validation.");
  const selected = selectProjects(candidate, o.projects, { includeDependencies: true });
  const oldSelected = selectProjects(baseline, o.projects, { includeDependencies: true });
  const apps = selected.map((p) => p.app);
  const oldApps = oldSelected.map((p) => p.app);
  assertUpgradeApps(oldApps, apps);
  const tests = selected.filter((p) => p.isTest).map((p) => p.app.id);
  const oldTests = oldSelected.filter((p) => p.isTest).map((p) => p.app.id);
  if (!tests.length || !oldTests.length || selected.every((p) => p.isTest) || oldSelected.every((p) => p.isTest)) {
    throw new Error("Select production and test apps explicitly in both repositories.");
  }

  const id = randomUUID();
  const reportFile = join(workDir(candidate, "validation", id), "report.json");
  const metadata = {
    id, reportFile, scope: "upgrade-and-data", baselineRepo: baseline.root, repo: candidate.root,
    target: o.target, targetType: target.type, company: o.company, companies, failOn,
    baselineMode: o.baselinePackages ? "released-packages" : "source",
    baselinePackagePins: o.baselinePackages,
    baselineApps: oldApps, candidateApps: apps,
    diagnostics: {
      snapshot: { status: "not-run", reason: "Separate authorized official proxy capture required." },
      profile: { status: "not-run", reason: "A nonempty official proxy capture is required; registration is not evidence." },
    },
    warning: "No cleanup or rollback is attempted. Inspect target state after a failure or timeout.",
  };
  let connection: Connection;
  let server: { version?: string; authentication?: string } = {};
  let before: InputSnapshot;
  let after: InputSnapshot;
  let companySnapshot: string[] = [];
  let releasedEvidence: { file: string; sha256: string; app: ValidationApp }[] | undefined;
  const baselinePackages = join(dirname(reportFile), "baseline-packages");
  const candidatePackages = join(dirname(reportFile), "candidate-packages");
  const identity = async (repo: typeof candidate, config: typeof cfg) => {
    const tool = await resolveAltool();
    const analyzers = resolveAnalyzers(repo, config, dirname(tool.path));
    if (!analyzers.succeeded) throw new Error(`Missing analyzers: ${analyzers.missing.join(", ")}`);
    return captureInputs(repo, config, JSON.stringify([tool, createHash("sha256").update(readFileSync(tool.path)).digest("hex"), analyzers.resolved]));
  };
  const unchanged = async (repo: typeof candidate, config: typeof cfg, expected: InputSnapshot) => {
    if (JSON.stringify(await identity(repo, config)) !== JSON.stringify(expected)) {
      throw new Error("Source, configuration, compiler, analyzers, symbols or artifacts changed after preparation. Start a new validation.");
    }
  };
  const installed = async (): Promise<ValidationApp[]> => {
    if (target.type !== "docker") throw new Error("Installed app inspection unavailable for this target.");
    const text = await invokeInContainer(target.container,
      "$apps = @(Get-NAVAppInfo -ServerInstance BC -Tenant default -TenantSpecificProperties | Where-Object { $_.IsInstalled } | ForEach-Object { @{ id = \"$($_.AppId)\"; name = $_.Name; publisher = $_.Publisher; version = \"$($_.Version)\" } }); Write-Output ('##VALIDATION##' + (ConvertTo-Json -InputObject $apps -Compress))", log);
    const line = text.split(/\r?\n/).find((l) => l.startsWith("##VALIDATION##"));
    if (!line) throw new Error("Installed app inspection returned no structured evidence.");
    const value: unknown = JSON.parse(line.slice("##VALIDATION##".length));
    if (!Array.isArray(value) || !value.every((a: unknown) => a !== null && typeof a === "object" &&
      ["id", "name", "publisher", "version"].every((key) => typeof Reflect.get(a, key) === "string"))) {
      throw new Error("Invalid installed app evidence.");
    }
    return value;
  };
  const inspectCompanies = async (): Promise<string[]> => {
    if (target.type !== "docker") throw new Error("Company inspection unavailable for this target.");
    const text = await invokeInContainer(target.container,
      "$companies = @(Get-NAVCompany -ServerInstance BC -Tenant default | ForEach-Object { $_.CompanyName }); Write-Output ('##COMPANIES##' + (ConvertTo-Json -InputObject $companies -Compress))", log);
    const line = text.split(/\r?\n/).find((l) => l.startsWith("##COMPANIES##"));
    const value: unknown = line ? JSON.parse(line.slice("##COMPANIES##".length)) : undefined;
    if (!Array.isArray(value) || !value.every((c): c is string => typeof c === "string" && c.trim().length > 0) ||
        new Set(value).size !== value.length || companies.some((c) => !value.includes(c))) {
      throw new Error("Dedicated validation companies could not be verified.");
    }
    return value.sort();
  };
  const checkCompanies = async (): Promise<StageResult> => {
    const current = await inspectCompanies();
    if (o.companies && JSON.stringify(current) !== JSON.stringify(companySnapshot)) {
      throw new Error("Validation company set changed after preflight; inspect target state before retrying.");
    }
    return { status: "passed", evidence: { companies, companySnapshot: current } };
  };
  const archiveReleasedPackages = async () => {
    const expected = oldSelected.filter((p) => !p.isTest).map((p) => p.app);
    const receipts: { file: string; sha256: string; app: ValidationApp }[] = [];
    if (o.baselinePackages!.length !== expected.length) throw new Error("Supply exactly one released package for every selected baseline production app.");
    mkdirSync(baselinePackages, { recursive: true });
    for (const [index, pin] of o.baselinePackages!.entries()) {
      const file = join(baselinePackages, `released-${index}.app`);
      copyFileSync(pin.file, file);
      const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
      if (sha256 !== pin.sha256.toLowerCase()) throw new Error(`Released baseline package SHA-256 mismatch: ${pin.file}`);
      const manifest = await runAltool<ValidationApp>(["gpm", file], { stream: false, log, timeoutMs: o.timeoutMs });
      const app = manifest.json;
      if (manifest.exitCode !== 0 || !app || ![app.id, app.name, app.publisher, app.version].every((v) => typeof v === "string")) {
        throw new Error(`Released baseline manifest inspection failed: ${pin.file}`);
      }
      const match = expected.find((a) => a.id.toLowerCase() === app.id.toLowerCase());
      if (!match || receipts.some((r) => r.app.id.toLowerCase() === app.id.toLowerCase())) {
        throw new Error("Released baseline package identity is unexpected or duplicated.");
      }
      assertInstalledApps([match], [app]);
      if (createHash("sha256").update(readFileSync(file)).digest("hex") !== sha256) throw new Error("Released baseline package changed during inspection.");
      const archived = join(baselinePackages, appFileName(match));
      renameSync(file, archived);
      const expectedName = appFileName(match).toLowerCase();
      const prefix = appFileName({ ...match, version: "" }).slice(0, -4).toLowerCase();
      if (readdirSync(outputDir(baseline)).some((name) =>
        name.toLowerCase().startsWith(prefix) && name.toLowerCase().endsWith(".app") && name.toLowerCase() !== expectedName)) {
        throw new Error("Competing baseline production output has another version. Use a clean baseline repository; existing files were not removed.");
      }
      copyFileSync(archived, join(outputDir(baseline), appFileName(match)));
      receipts.push({ file: archived, sha256, app });
    }
    return receipts;
  };
  const prepare = async (repo: typeof candidate, config: typeof cfg): Promise<StageResult> => {
    const symbols = await downloadSymbols(repo, config, { projects: o.projects, log });
    if (!symbols.projects.length || !symbols.projects.every((p) => p.succeeded)) return { status: "failed", reason: "Symbols failed.", evidence: symbols };
    const released = repo === baseline && o.baselinePackages ? await archiveReleasedPackages() : undefined;
    if (released) releasedEvidence = released;
    const inputs = await identity(repo, config);
    const result = await build(repo, config, {
      projects: released ? oldTests : o.projects, includeDependencies: !released,
      failOn, autoSymbols: false, log, timeoutMs: o.timeoutMs,
    });
    const fresh = await identity(repo, config);
    if (inputs.shared !== fresh.shared || JSON.stringify(inputs.sources) !== JSON.stringify(fresh.sources)) {
      return { status: "failed", reason: "Inputs changed during preparation; no package may be deployed.", evidence: result };
    }
    if (released?.some((r) => fresh.outputs[r.app.id] !== r.sha256)) throw new Error("Released baseline package changed during preparation.");
    return {
      status: result.succeeded ? "passed" : "failed",
      reason: result.succeeded ? undefined : `Fresh build failed (failOn: ${failOn}).`,
      evidence: result,
    };
  };
  const discovery = async (repo: typeof candidate, ids: string[], codeunits: string[], methods: string[], folder: string) => {
    const groups: unknown[] = [];
    for (const project of selectProjects(repo, ids)) {
      const result = await runAltool<{ succeeded?: boolean; codeunits?: unknown[] }>(["listtests", "--appfile", join(folder, appFileName(project.app))], { stream: false, log, timeoutMs: o.timeoutMs });
      if (result.exitCode !== 0 || result.json?.succeeded === false || !Array.isArray(result.json?.codeunits)) throw new Error(`Test discovery failed for ${project.app.name}.`);
      groups.push(...result.json.codeunits);
    }
    assertTestSelection(groups, codeunits, methods);
    return { status: "passed" as const, evidence: { codeunits, methods } };
  };
  const archiveTests = (name: string, result: TestResult) => {
    for (const [i, project] of result.projects.entries()) {
      if (project.resultFile) {
        const file = join(dirname(reportFile), `${name}-${i}.json`);
        copyFileSync(project.resultFile, file);
        project.resultFile = file;
      }
    }
    return testEvidence(result);
  };
  const freezePackages = (repo: typeof candidate, snapshot: InputSnapshot, folder: string) => {
    mkdirSync(folder, { recursive: true });
    for (const project of selectProjects(repo, o.projects, { includeDependencies: true })) {
      const file = join(folder, appFileName(project.app));
      copyFileSync(join(outputDir(repo), appFileName(project.app)), file);
      if (createHash("sha256").update(readFileSync(file)).digest("hex") !== snapshot.outputs[project.app.id]) {
        throw new Error("Package changed while archiving validation artifacts.");
      }
    }
  };
  const checkPackages = (repo: typeof candidate, snapshot: InputSnapshot, folder: string) => {
    for (const project of selectProjects(repo, o.projects, { includeDependencies: true })) {
      const file = join(folder, appFileName(project.app));
      if (createHash("sha256").update(readFileSync(file)).digest("hex") !== snapshot.outputs[project.app.id]) {
        throw new Error("Archived validation package changed. Start a new validation.");
      }
    }
  };
  const deploy = async (repo: typeof candidate, config: typeof cfg, snapshot: InputSnapshot, folder: string): Promise<StageResult> => {
    await unchanged(repo, config, snapshot);
    checkPackages(repo, snapshot, folder);
    const result = await publish(repo, connection, { projects: o.projects, includeDependencies: true, packageFolder: folder, schemaUpdateMode: "Synchronize", log, timeoutMs: o.timeoutMs });
    return { status: result.succeeded ? "passed" : "failed", evidence: result };
  };
  const lockDir = join(USER_DIR, "validation-locks");
  mkdirSync(lockDir, { recursive: true });
  // Target-wide: app installation is tenant-wide, even when companies differ.
  const key = target.type === "docker" ? `docker:${target.container.toLowerCase()}` : JSON.stringify(target);
  const lock = join(lockDir, `${createHash("sha256").update(key).digest("hex")}.lock`);
  let fd: number;
  try { fd = openSync(lock, "wx"); }
  catch (error) {
    if (existsSync(lock)) throw new Error(`Validation target is locked: ${lock}. Inspect the owning run before removing a stale lock.`);
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ id, pid: process.pid, reportFile }));
    const report = await runValidationStages([
      { name: "target-preflight", run: async () => {
        if (target.type !== "docker") return { status: "blocked", reason: "Read-only installed-version inspection is not implemented for this target. No build, publish or Admin API call was made." };
        const info = await inspectContainer(target.container);
        server = { version: info.bcVersion, authentication: info.auth };
        connection = await resolveConnection(target);
        companySnapshot = await inspectCompanies();
        const have = await installed();
        const conflicts = have.filter((a) => apps.some((b) => b.id.toLowerCase() === a.id.toLowerCase()));
        if (conflicts.length) return { status: "blocked", reason: "Fixture apps are already installed. Use a fresh authorized target; no downgrade or uninstall is attempted.", evidence: conflicts };
        return { status: "passed", evidence: { ...server, installedApps: have, companies, companySnapshot } };
      } },
      { name: "prepare-baseline", run: async () => {
        const result = await prepare(baseline, oldCfg);
        if (result.status === "passed") {
          before = await identity(baseline, oldCfg);
          freezePackages(baseline, before, baselinePackages);
          result.evidence = { build: result.evidence, releasedPackages: releasedEvidence, inputs: before, packageFolder: baselinePackages };
        }
        return result;
      } },
      { name: "prepare-candidate", run: async () => {
        const result = await prepare(candidate, cfg);
        if (result.status === "passed") {
          after = await identity(candidate, cfg);
          freezePackages(candidate, after, candidatePackages);
          result.evidence = { build: result.evidence, inputs: after, packageFolder: candidatePackages };
        }
        return result;
      } },
      { name: "discover-seed-tests", run: () => discovery(baseline, oldTests, o.seedCodeunits, o.seedMethods, baselinePackages) },
      { name: "discover-verification-tests", run: () => discovery(candidate, tests, o.verifyCodeunits, o.verifyMethods, candidatePackages) },
      { name: "publish-baseline", run: () => deploy(baseline, oldCfg, before, baselinePackages) },
      { name: "installed-baseline", run: async () => { const have = await installed(); assertInstalledApps(oldApps, have); return { status: "passed", evidence: have }; } },
      ...companies.map((company, index) => ({ name: companies.length === 1 ? "seed-data" : `seed-data:${index + 1}`, run: async () => {
        await unchanged(baseline, oldCfg, before);
        checkPackages(baseline, before, baselinePackages);
        const result = archiveTests(`seed-${index + 1}`, await runTests(baseline, connection, { projects: oldTests, packageFolder: baselinePackages, company, codeunits: o.seedCodeunits, methods: o.seedMethods, timeoutMs: o.timeoutMs, log }));
        return { ...result, evidence: { company, tests: result.evidence } };
      } })),
      { name: "companies-before-upgrade", run: checkCompanies },
      { name: "publish-candidate", run: () => deploy(candidate, cfg, after, candidatePackages) },
      { name: "installed-candidate", run: async () => { const have = await installed(); assertInstalledApps(apps, have); return { status: "passed", evidence: have }; } },
      { name: "companies-after-upgrade", run: checkCompanies },
      ...companies.map((company, index) => ({ name: companies.length === 1 ? "verify-data" : `verify-data:${index + 1}`, run: async () => {
        await unchanged(candidate, cfg, after);
        checkPackages(candidate, after, candidatePackages);
        const result = archiveTests(`verify-${index + 1}`, await runTests(candidate, connection, { projects: tests, packageFolder: candidatePackages, company, codeunits: o.verifyCodeunits, methods: o.verifyMethods, timeoutMs: o.timeoutMs, log }));
        return { ...result, evidence: { company, tests: result.evidence } };
      } })),
    ], (report) => {
      writeFileSync(`${reportFile}.tmp`, JSON.stringify({ ...metadata, releasedBaselinePackages: releasedEvidence, server, ...report }, null, 2));
      renameSync(`${reportFile}.tmp`, reportFile);
    });
    return { ...metadata, releasedBaselinePackages: releasedEvidence, server, ...report };
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
