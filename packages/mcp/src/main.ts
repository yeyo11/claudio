// Claudio's own MCP server: JSON-RPC 2.0 over stdio, one message per line, answered from the REST API
// of the Claudio that started the chat. The CLI starts it from the file passed with --mcp-config.
import { createInterface } from 'node:readline';
import { apiUrlFrom, createClient } from './client.ts';
import { CLAUDIO_MCP_TOOLSETS_ENV, toolsetsFrom } from './names.ts';
import { createServer, toolsFor } from './server.ts';

const baseUrl = apiUrlFrom(process.env.CLAUDIO_API_URL);
if (!baseUrl) {
  process.stderr.write('claudio-mcp: CLAUDIO_API_URL is not set; this server only talks to the Claudio that started the chat\n');
  process.exit(1);
}

const server = createServer({
  api: createClient({ baseUrl, token: process.env.CLAUDIO_API_TOKEN, chatId: process.env.CLAUDIO_CHAT_ID }),
  version: process.env.CLAUDIO_VERSION || 'unknown',
  // Claudio names the toolsets in the chat's config: a project chat gets the reads of its teammates' copies and nothing else
  tools: toolsFor(toolsetsFrom(process.env[CLAUDIO_MCP_TOOLSETS_ENV])),
});

// Requests are answered in the order they came, so a slow call cannot reorder the replies' lines
let queue: Promise<void> = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  queue = queue.then(async () => {
    const out = await server.handleLine(line);
    if (out !== undefined) process.stdout.write(`${out}\n`);
  });
});
// stdin closing is how the CLI ends the server; let the queue drain first
lines.on('close', () => void queue.then(() => process.exit(0)));
