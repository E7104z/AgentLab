/**
 * Authorize a mailbox once:   npm run auth            (mailbox "main")
 *                             npm run auth -- sales   (mailbox "sales")
 * Opens a consent URL. Sign in AS the mailbox you want AgentLab to read and send from
 * (for The Real Help: info@thecdscloud.com), approve, and copy the printed line into your env.
 */
require('dotenv').config();
const { google } = require('googleapis');
const express = require('express');

const mailbox = (process.argv[2] || 'main').toLowerCase();
const envName = 'GMAIL_REFRESH_TOKEN_' + mailbox.toUpperCase().replace(/[^A-Z0-9]/g, '_');

for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) {
  if (!process.env[key]) {
    console.error('Missing ' + key + ' in .env. Fill in the OAuth client fields first.');
    process.exit(1);
  }
}

const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify', // read inbox, apply labels, send
  'https://www.googleapis.com/auth/gmail.compose', // drafts
  'https://www.googleapis.com/auth/documents', // proposals
  'https://www.googleapis.com/auth/drive', // copy the proposal template, share the link
  'https://www.googleapis.com/auth/spreadsheets', // weekly scorecard sheet
];

const app = express();
app.get('/oauth2callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    res.send('Done. Check your terminal, then close this tab.');
    console.log('\nAdd this line to your env (Railway Variables or .env):\n');
    console.log(envName + '=' + tokens.refresh_token + '\n');
    process.exit(0);
  } catch (err) {
    res.status(500).send('Something went wrong: ' + err.message);
    console.error(err);
    process.exit(1);
  }
});

const port = Number(new URL(process.env.GOOGLE_REDIRECT_URI).port || 3456);
app.listen(port, () => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  console.log(`\nAuthorizing mailbox "${mailbox}". Open this URL and sign in as that mailbox:\n`);
  console.log(url);
  console.log('\nWaiting for approval...\n');
});
