import assert from "node:assert/strict";
import { it } from "node:test";
import { createTestBudget } from "./test-control.js";

it("uses one remaining deadline across discovery and execution", async () => {
  const budget = createTestBudget(80);
  const first = budget.remaining();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(first <= 80 && first > 0);
  assert.throws(() => budget.remaining(), /deadline/i);
  assert.equal(budget.timedOut(), true);
});

it("rejects cancellation and invalid test budgets before further stages", () => {
  const controller = new AbortController();
  controller.abort();
  const budget = createTestBudget(1000, controller.signal);
  assert.throws(() => budget.remaining(), /cancel/i);
  assert.equal(budget.cancelled(), true);
  for (const timeout of [0, -1, NaN, 1.5]) assert.throws(() => createTestBudget(timeout));
});
