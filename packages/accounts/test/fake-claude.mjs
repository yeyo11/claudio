#!/usr/bin/env node
// A stand-in for the claude CLI that honours CLAUDE_CONFIG_DIR: the account is whatever sits in
// `<dir>/fake-login.json`, which `auth login` writes after reading a code on stdin.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
} else {
  // Anything else reports which account the process got
  console.log(JSON.stringify({ args: process.argv.slice(2), dir: process.env.CLAUDE_CONFIG_DIR ?? null, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, key: process.env.ANTHROPIC_API_KEY ?? null }));
}
