import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface WhaleState {
  updates?: Record<string, { checkedAt: string; info: unknown }>;
}

export function stateFile(home = homedir()): string {
  return join(process.env.BC_WHALE_HOME ?? join(home, ".bc-whale"), "whale-state.json");
}

export function readState(file: string): WhaleState {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as WhaleState;
  } catch {
    return {};
  }
}

export function writeState(file: string, state: WhaleState) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}
