import readline from "node:readline/promises";
import type { z } from "zod";
import { adapter } from "penguin";

type Ask = {
  (question: string): Promise<string>;
  <Shape extends z.ZodType>(question: string, shape: Shape): Promise<z.infer<Shape>>;
};

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.join(".");
      return at === "" ? issue.message : `${at}: ${issue.message}`;
    })
    .join(", ");
}

async function line(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/** A person types text. JSON is how they type a number, list, or object. */
function candidates(raw: string): unknown[] {
  const list: unknown[] = [raw];
  try {
    list.push(JSON.parse(raw));
  } catch {
    // not JSON, the raw text stands alone
  }
  return list;
}

export default adapter({
  role: "view",
  name: "terminal",
  description: "shows the run on stdout and asks questions on stdin",
  build: () => {
    let queue: Promise<unknown> = Promise.resolve();

    const ask = ((question: string, shape?: z.ZodType) => {
      const turn = queue.then(async () => {
        for (;;) {
          const raw = (await line(`\n? ${question}\n> `)).trim();
          if (shape === undefined) return raw;
          let problem = "";
          for (const candidate of candidates(raw)) {
            const checked = shape.safeParse(candidate);
            if (checked.success) return checked.data;
            if (problem === "") problem = issues(checked.error);
          }
          process.stdout.write(`that answer does not fit: ${problem}\n`);
        }
      });
      queue = turn.then(
        () => undefined,
        () => undefined,
      );
      return turn;
    }) as Ask;

    return {
      async show(text: string): Promise<void> {
        process.stdout.write(`${text}\n`);
      },
      ask,
    };
  },
});
