import readline from "node:readline/promises";

export async function ask(question: string): Promise<string | undefined> {
  process.stdout.write(`\ngate: ${question}\n`);
  if (!process.stdin.isTTY) return undefined;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("> ")).trim();
    return answer === "" ? undefined : answer;
  } finally {
    rl.close();
  }
}
