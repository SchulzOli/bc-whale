---
name: bc-whale-bugfix
description: "Use when reproducing and fixing an AL bug with bc-whale evidence, complete analyzers and official AL MCP, then verifying the correction."
argument-hint: "Repo, affected apps, concrete symptom, regression test and optional authorized target/session"
---

Execute the following workflow in order. Never use BcContainerHelper.

1. Understand the provided symptom and select affected apps with `bc_whale_info`. Preserve unrelated changes.
2. Call `bc_whale_analyzers`. If any configured analyzer is missing, provision a trusted local suite (including
   companions) with its `source` argument; never download or run arbitrary DLLs or relax the analyzer config.
3. For runtime bugs, add a focused regression test before correcting production code. Choose only an authorized
   test target, install required dependencies with `bc_whale_deps`, and supply its name and exact test filters.
4. Call `bc_whale_fix_start` with repo, concrete issue and explicit project selection. If no failure is reproduced,
   investigate and improve the regression scenario rather than claiming success. Infrastructure errors are not
   reproduced bugs. Without a target, verification covers diagnostics only, not runtime behavior.
5. Follow all diagnostic pages with `bc_whale_diagnostics`. Read exact source locations and source hashes.
   Use AL MCP symbol search and relations to establish the affected APIs and callers. Cite actual returned
   definitions and official Microsoft documentation for semantics; do not invent relationships or URLs.
6. Implement the smallest root-cause correction using the available edit tools. Use `bc_whale_check` while iterating.
   Do not suppress rules merely to get a green result, remove regression tests or change expected outputs to hide a bug.
7. If runtime evidence is needed, use the explicitly registered snapshot/profile MCP tools, not shell substitutes:
   capture only the selected session, stop your capture, and cite profile/snapshot identifiers. Do not attach to
   other users' sessions or collect production data without authorization. Snapshot archives can contain sensitive data.
8. Call `bc_whale_fix_verify` with the baseline id. It performs a fresh build (and publish/tests if the baseline
   selected a target), rejects unchanged sources and configuration bypasses, and saves a verification report.
   If it fails, diagnose and iterate; if the baseline no longer represents the scenario, reproduce a new baseline.
9. Report the symptom, root cause, exact changed file/line, rule or test name, baseline and verification report
   paths, source hashes, executed test counts and any unverified runtime behavior. A diagnostics-only result is
   never a claim that a runtime bug is fixed. Commit/push only when requested.
