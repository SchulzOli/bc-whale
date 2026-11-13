export function verifyFixEvidence(baseline: { succeeded: boolean }, verification: { succeeded: boolean }, sourceChanged: boolean) {
  const reasons: string[] = [];
  if (baseline.succeeded) reasons.push("No failure was reproduced.");
  if (!sourceChanged) reasons.push("No source change was recorded.");
  if (!verification.succeeded) reasons.push("Fresh verification failed.");
  return { succeeded: reasons.length === 0, reasons };
}
