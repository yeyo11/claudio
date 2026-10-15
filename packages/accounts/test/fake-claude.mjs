#!/usr/bin/env node
// A stand-in for the claude CLI that honours CLAUDE_CONFIG_DIR: the account is whatever sits in
// `<dir>/fake-login.json`, which `auth login` writes after reading a code on stdin.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.CLAUDE_CONFIG_DIR ?? '/nonexistent';
const marker = join(dir, 'fake-login.json');
const [a, b] = process.argv.slice(2);

if (a === 'auth' && b === 'status') {
  if (existsSync(marker)) {
    const who = JSON.parse(readFileSync(marker, 'utf8'));
    console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', configDirectory: dir, email: who.email, orgId: 'o', orgName: who.org, subscriptionType: 'max' }));
  } else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.log(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', configDirectory: dir }));
  } else {
    console.log(JSON.stringify({ loggedIn: false, authMethod: 'none', configDirectory: dir }));
    process.exit(1);
  }
} else if (a === 'auth' && b === 'login') {
  console.log('Opening browser to sign in…\nIf the browser did not open, visit: https://claude.example/authorize?state=x');
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', (code) => {
    if (code.trim() !== 'good-code') process.exit(1);
    writeFileSync(marker, JSON.stringify({ email: `${dir.split('/').pop()}@example.com`, org: 'Org' }));
    console.log('Login successful.');
    process.exit(0);
  });
} else if (a === '--version') {
  console.log(process.env.FAKE_CLAUDE_VERSION ?? '2.1.300 (Claude Code)');
} else if (process.argv.includes('--input-format')) {
  // The initialize handshake: the account's model list, no turn. A token account is a Pro-like one.
  appendFileSync(join(dir, 'initialize-count'), 'x');
  const max = !process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'];
  const models = [
    { value: 'default', resolvedModel: 'claude-sonnet-5-5', displayName: 'Default (recommended)', description: 'Sonnet 5.5', supportsEffort: true, supportedEffortLevels: effort.slice(0, 3) },
    ...(max ? [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · most capable', supportsEffort: true, supportedEffortLevels: effort, supportsThinkingOff: true }] : []),
    { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'Haiku 5.5 · fastest', supportsEffort: false },
  ];
  const account = max ? { email: 'a@example.com', organization: 'Org', subscriptionType: process.env.FAKE_CLAUDE_PLAN ?? 'Claude Max', apiProvider: 'firstParty' } : { apiProvider: 'firstParty' };
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.type === 'control_request' && msg.request.subtype === 'initialize') {
        console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { commands: [], models, account } } }));
      }
    }
  });
} else {
  // Anything else reports which account the process got
  console.log(JSON.stringify({ args: process.argv.slice(2), dir: process.env.CLAUDE_CONFIG_DIR ?? null, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, key: process.env.ANTHROPIC_API_KEY ?? null }));
}
