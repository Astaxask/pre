/**
 * One-time OAuth setup for Google Calendar.
 *
 * Run with: pnpm --filter @pre/integrations setup:google
 *
 * Reads GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from the project .env file
 * or from the environment.
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import * as readline from 'node:readline';

// Load .env from project root (integrations package is at packages/integrations/)
const projectRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const envPath = join(projectRoot, '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
const PRE_DIR = join(homedir(), '.pre');
const TOKEN_PATH = join(PRE_DIR, 'google-tokens.json');

async function main(): Promise<void> {
  const clientId = process.env['GOOGLE_CLIENT_ID'];
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET'];

  if (!clientId) {
    console.error('Error: GOOGLE_CLIENT_ID is not set');
    process.exit(1);
  }
  if (!clientSecret) {
    console.error('Error: GOOGLE_CLIENT_SECRET is not set');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'urn:ietf:wg:oauth:2.0:oob',
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('\n── Google Calendar OAuth Setup ──');
  console.log('1. Open this URL in your browser:\n');
  console.log(' ', authUrl, '\n');
  console.log('2. Sign in and grant access');
  console.log('3. Copy the authorization code shown');
  console.log('4. Paste it here and press Enter:');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await new Promise<string>((resolve) => {
    rl.question('\n> ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!code) {
    console.error('No code entered. Aborting.');
    process.exit(1);
  }

  const { tokens } = await oauth2Client.getToken(code);

  if (!existsSync(PRE_DIR)) {
    mkdirSync(PRE_DIR, { recursive: true });
  }

  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf-8');

  console.log('\n✓ Tokens saved to ~/.pre/google-tokens.json');
  console.log('  Restart the gateway — Google Calendar will now initialize.');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('OAuth setup failed:', message);
  process.exit(1);
});
