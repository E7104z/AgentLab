const fs = require('fs');
const path = require('path');

const CLIENTS_DIR = path.join(__dirname, 'clients');

function loadClients() {
  const files = fs.readdirSync(CLIENTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_example'));
  const clients = files.map(f => JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, f), 'utf8')));
  return clients;
}

/**
 * Given the raw "To" header of an inbound email, find which client it
 * belongs to. Matches on intakeAlias substring (e.g. leads+acme@therealhelp.com).
 * Falls back to the "default" client (jason@therealhelp.com with no alias).
 * Returns null if a plus-alias is present but doesn't match any known client
 * -- that's flagged as unrouted rather than guessed at.
 */
function matchClient(toHeader, clients) {
  const lower = (toHeader || '').toLowerCase();

  const aliasMatch = clients.find(c => c.intakeAlias && lower.includes(c.intakeAlias.toLowerCase()));
  if (aliasMatch) return aliasMatch;

  const hasPlusAlias = /\+[^@]+@/.test(lower);
  if (hasPlusAlias) return null; // addressed to *someone's* alias, but not one we recognize

  return clients.find(c => c.id === 'default') || null;
}

module.exports = { loadClients, matchClient };