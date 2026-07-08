/**
 * Run once: node get-refresh-token.js
 * Opens a URL you paste into your browser, log in AS jason@therealhelp.com,
 * approve access, and it'll print the refresh token to save in .env.
 */
require('dotenv').config();
const { google } = require('googleapis');
const express = require('express');

const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error('Missing ' + key + ' in .env — fill in the OAuth client fields first.');
    process.exit(1);
  }
}

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// gmail.compose = create drafts / send
// gmail.modify  = read inbox + apply labels (needed for the inbox poller)
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify'
];

const app = express();

app.get('/oauth2callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    res.send('Done — check your terminal, then close this tab.');
    console.log('\nAdd this line to your .env file:\n');
    console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('\n');
    process.exit(0);
  } catch (err) {
    res.status(500).send('Something went wrong: ' + err.message);
    console.error(err);
    process.exit(1);
  }
});

app.listen(process.env.PORT || 3456, () => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
  console.log('\nOpen this URL in your browser and log in as jason@therealhelp.com:\n');
  console.log(url);
  console.log('\nWaiting for you to approve access...\n');
});
