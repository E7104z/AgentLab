/**
 * All runtime configuration, read once from the environment.
 * No addresses or secrets are hardcoded anywhere else in the app.
 */
const bool = (v, def = false) => (v === undefined || v === '' ? def : String(v).toLowerCase() === 'true');
const num = (v, def) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? def : Number(v));

function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 3456),
    appBaseUrl: (env.APP_BASE_URL || '').replace(/\/$/, ''),

    // Master kill switch default. A redeploy always resets to this value.
    agentEnabledDefault: bool(env.AGENT_ENABLED, false),

    databaseUrl: env.DATABASE_URL || '',

    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    model: env.MODEL || 'claude-haiku-5-5',
    modelWriter: env.MODEL_WRITER || 'claude-sonnet-5-5',

    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      redirectUri: env.GOOGLE_REDIRECT_URI || 'http://localhost:3456/oauth2callback',
    },
    // Mailbox refresh tokens live in env as GMAIL_REFRESH_TOKEN_<NAME> (NAME upper-cased).
    // GOOGLE_REFRESH_TOKEN is accepted as the token for the mailbox named "main".
    mailboxToken(name) {
      const key = 'GMAIL_REFRESH_TOKEN_' + String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_');
      return env[key] || (name === 'main' ? env.GOOGLE_REFRESH_TOKEN || '' : '');
    },

    pollEnabled: bool(env.POLL_ENABLED, false),
    pollIntervalMs: num(env.POLL_INTERVAL_MS, 120000),
    tickIntervalMs: num(env.TICK_INTERVAL_MS, 30000),

    adminUser: env.ADMIN_USER || '',
    adminPassword: env.ADMIN_PASSWORD || '',

    alertEmail: env.ALERT_EMAIL || 'info@thecdscloud.com',

    leadWebhookSecret: env.LEAD_WEBHOOK_SECRET || '',
    calWebhookSecret: env.CAL_WEBHOOK_SECRET || '',

    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
      priceSetup: env.STRIPE_PRICE_SETUP || '',
      priceMonthly: env.STRIPE_PRICE_MONTHLY || '',
      successUrl: env.STRIPE_SUCCESS_URL || 'https://therealhelp.com/?paid=1',
      cancelUrl: env.STRIPE_CANCEL_URL || 'https://therealhelp.com/',
    },

    proposals: {
      templateDocId: env.PROPOSAL_TEMPLATE_DOC_ID || '',
      folderId: env.PROPOSAL_FOLDER_ID || '',
      shareWithLink: bool(env.PROPOSAL_SHARE_WITH_LINK, true),
    },

    scorecardSheetId: env.SCORECARD_SHEET_ID || '',

    portal: {
      enabled: bool(env.PORTAL_INVITE_ENABLED, false),
      serviceAccountJson: env.PORTAL_FIREBASE_SERVICE_ACCOUNT || '',
    },
  };
}

module.exports = { loadConfig };
