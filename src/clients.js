const fs = require('fs');
const path = require('path');

const DEFAULT_CLIENTS_DIR = path.join(__dirname, '..', 'clients');

/**
 * Loads every client from clients/<id>/client.json (+ knowledge.md).
 * Folders starting with "_" are templates and are skipped.
 */
function loadClients(dir = DEFAULT_CLIENTS_DIR) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => {
      const folder = path.join(dir, d.name);
      const cfgPath = path.join(folder, 'client.json');
      if (!fs.existsSync(cfgPath)) return null;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const kPath = path.join(folder, 'knowledge.md');
      cfg.knowledge = fs.existsSync(kPath) ? fs.readFileSync(kPath, 'utf8') : '';
      cfg.sequences = cfg.sequences || {};
      cfg.templates = cfg.templates || {};
      cfg.mailbox = cfg.mailbox || 'main';
      cfg.sendMode = (cfg.sendMode || 'log').toLowerCase();
      if (!cfg.id) cfg.id = d.name;
      return cfg;
    })
    .filter(Boolean);
}

function extractAddresses(header) {
  return String(header || '')
    .toLowerCase()
    .match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
}

/**
 * Given the recipient headers of an inbound email (To, Cc, Delivered-To),
 * returns the client it belongs to.
 * - An exact intakeAlias match wins.
 * - A plus-address that matches no client returns null (flagged as unrouted, never guessed).
 * - Otherwise the default client for that mailbox ("default" first, then any client without an alias).
 */
function matchClient(recipientHeaders, clients, mailbox = 'main') {
  const addrs = extractAddresses(recipientHeaders);
  const alias = clients.find((c) => c.intakeAlias && addrs.includes(c.intakeAlias.toLowerCase()));
  if (alias) return alias;

  const mailboxClients = clients.filter((c) => c.mailbox === mailbox);
  const own = new Set(mailboxClients.map((c) => (c.fromEmail || '').toLowerCase()).filter(Boolean));
  const plusToUs = addrs.some((a) => {
    const [local, domain] = a.split('@');
    if (!local.includes('+')) return false;
    const base = local.split('+')[0] + '@' + domain;
    return own.size === 0 || own.has(base);
  });
  if (plusToUs) return null;

  return (
    mailboxClients.find((c) => c.id === 'default') ||
    mailboxClients.find((c) => !c.intakeAlias) ||
    null
  );
}

module.exports = { loadClients, matchClient, extractAddresses };
