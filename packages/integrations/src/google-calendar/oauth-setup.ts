/**
 * One-time OAuth setup for Google Calendar.
 *
 * Run with: pnpm --filter @pre/integrations setup:google
 *
 * Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment.
 */

import { google } from 'googleapis';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as readline from 'node:readline';

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
