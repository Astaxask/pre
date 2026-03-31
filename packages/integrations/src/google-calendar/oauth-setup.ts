/**
 * One-time OAuth setup for Google Calendar.
 *
 * Run with: pnpm --filter @pre/integrations setup:google
 *
 * Reads GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from the project .env file
 * or from the environment.
 *
 * Spins up a temporary localhost server to receive the OAuth callback
 * (Google deprecated the OOB redirect in 2022).
 */

import { google } from 'googleapis';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { URL } from 'node:url';

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
const REDIRECT_PORT = 18799;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

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
    REDIRECT_URI,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  // Wait for the OAuth callback on a temporary local server
  const code = await new Promise<string>((resolveCode, rejectCode) => {
    const server = createServer((req, res) => {
      if (!req.url?.startsWith('/oauth2callback')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const authCode = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>❌ Authorization denied</h2><p>You can close this tab.</p></body></html>');
        server.close();
        rejectCode(new Error(`Google denied access: ${error}`));
        return;
      }

      if (!authCode) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>❌ No authorization code received</h2></body></html>');
        server.close();
        rejectCode(new Error('No authorization code in callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>✅ PRE authorized!</h2><p>You can close this tab and return to the terminal.</p></body></html>');
      server.close();
      resolveCode(authCode);
    });

    server.listen(REDIRECT_PORT, () => {
      console.log('\n── Google Calendar OAuth Setup ──');
      console.log('1. Open this URL in your browser:\n');
      console.log(' ', authUrl, '\n');
      console.log('2. Sign in and grant calendar access');
      console.log(`3. You'll be redirected back automatically\n`);
      console.log(`Waiting for authorization on http://localhost:${REDIRECT_PORT} ...`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      rejectCode(new Error('Timed out waiting for authorization (5 minutes)'));
    }, 5 * 60 * 1000);
  });

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
