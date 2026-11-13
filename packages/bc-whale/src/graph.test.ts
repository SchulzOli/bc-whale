import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { graphFailure, parseQueryOutput, queryArgs, selectionArgs, sourceFingerprint } from "./graph.js";
import type { AlProject } from "./repo.js";

test("graph failures are detected even when altool exits 0", () => {
  const output = "Unhandled exception: System.FormatException: Unknown selector prefix 'bogus:' in 'bogus:x'.\n   at Microsoft...";
  assert.equal(graphFailure(output, 0), "Unknown selector prefix 'bogus:' in 'bogus:x'.");
  assert.equal(graphFailure("3 node(s):\n  A", 0), undefined);
  assert.match(graphFailure("boom", 2)!, /boom/);
});

test("query arguments require a selector, map options and reject option-like selectors", () => {
  assert.throws(() => queryArgs("g.jsonl", {}), /from' or 'to'/);
  assert.deepEqual(
    queryArgs("g.jsonl", { to: "obj:Codeunit/Post#Run", direction: "callers", edgeKinds: ["Direct", "Event"], depth: 0, paths: true, maxPaths: 5, exclude: "ns:*Test*" }),
    ["graph", "query", "--graph", "g.jsonl", "--to", "obj:Codeunit/Post#Run", "--direction", "callers", "--edge-kinds", "Direct,Event", "--depth", "0", "--exclude", "ns:*Test*", "--paths", "--max-paths", "5"],
  );
  assert.throws(() => selectionArgs({ from: "--out=x" }), /Invalid from selector/);
  assert.throws(() => selectionArgs({ from: "a", depth: -1 }), /depth/);
});

test("query output is parsed into nodes or paths", () => {
  assert.deepEqual(parseQueryOutput("Loading graph...\n2 node(s):\n  Table.FindSet\n  Table.Modify\n"), { kind: "nodes", count: 2, items: ["Table.FindSet", "Table.Modify"] });
  assert.deepEqual(parseQueryOutput("0 path(s):\n"), { kind: "paths", count: 0, items: [] });
  assert.throws(() => parseQueryOutput("something else"), /Unexpected/);
});

test("the source fingerprint changes with AL sources and manifests only", () => {
  const root = mkdtempSync(join(tmpdir(), "bc-whale-graph-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".alpackages"));
    writeFileSync(join(root, "app.json"), "{}");
    writeFileSync(join(root, "src", "A.Codeunit.al"), "codeunit 50100 A {}");
    const project = { path: root } as AlProject;
    const before = sourceFingerprint([project]);
    writeFileSync(join(root, ".alpackages", "Base.app"), "x");
    writeFileSync(join(root, "README.md"), "x");
    assert.equal(sourceFingerprint([project]), before);
    writeFileSync(join(root, "src", "A.Codeunit.al"), "codeunit 50100 A { }");
    assert.notEqual(sourceFingerprint([project]), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
