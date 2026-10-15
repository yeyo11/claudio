#!/usr/bin/env -S node --import tsx
import { createInterface } from 'node:readline/promises';
import { main } from './commands.ts';

const code = await main(
  process.argv.slice(2),
  {
    out: (t) => console.log(t),
    err: (t) => console.error(t),
    stdin: async () => {
      let data = '';
      for await (const chunk of process.stdin) data += String(chunk);
      return data;
    },
    prompt: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(q);
      } finally {
        rl.close();
      }
    },
  },
  { env: process.env },
);
process.exit(code);
