import { createInterface } from "node:readline/promises";

/** Prompts on stderr so stdout stays machine-readable. */
export function createPrompt(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr) {
  const rl = createInterface({ input, output, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question: string): Promise<string> => {
    output.write(question);
    const next = await lines.next();
    if (next.done) throw new Error("Input closed; use --yes for non-interactive setup");
    return next.value.trim();
  };
  return {
    ask,
    async choose(question: string, options: string[], defaults: string[]): Promise<string[]> {
      options.forEach((option, index) => output.write(`  ${index + 1}. ${defaults.includes(option) ? "[x]" : "[ ]"} ${option}\n`));
      const answer = await ask(`${question} (numbers separated by commas, Enter keeps [x]): `);
      if (!answer) return defaults;
      return answer.split(/[\s,]+/).filter(Boolean).map((token) => {
        const option = options[Number(token) - 1];
        if (!option) throw new Error(`Invalid choice: ${token}`);
        return option;
      });
    },
    async select(question: string, options: string[], fallback: string): Promise<string> {
      const answer = await ask(`${question} [${options.join("/")}] (${fallback}): `);
      if (!answer) return fallback;
      if (!options.includes(answer)) throw new Error(`Invalid choice: ${answer}`);
      return answer;
    },
    async confirm(question: string): Promise<boolean> {
      return /^y(es)?$/i.test(await ask(`${question} [y/N]: `));
    },
    close: () => rl.close(),
  };
}
