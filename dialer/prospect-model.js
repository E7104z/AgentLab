// Pure helpers shared by the store, queue and prospect logic.

const TERMINAL_CALL = new Set(['closed_won', 'not_interested', 'bad_number', 'dnc', 'exhausted']);

// Same business, same city -> same key (third matching step after phone and email).
function businessKey(lead) {
  const n = String(lead.businessName || '').toLowerCase()
    .replace(/&/g, ' and ').replace(/\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|ltd|dba|the)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const c = String(lead.city || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return n && c ? n + '|' + c : '';
}

// One set of stage names for both channels.
//   new -> contacted -> engaged -> interested -> booked -> won      (or lost / suppressed)
function stageOf(lead) {
  const s = lead.status || 'new';
  if (s === 'dnc' || lead.callBlocked || lead.emailState === 'suppressed') return 'suppressed';
  if (s === 'closed_won') return 'won';
  if (s === 'meeting_booked') return 'booked';
  if (s === 'interested') return 'interested';
  if (['not_interested', 'bad_number', 'exhausted'].includes(s)) return 'lost';
  if (s === 'callback' || lead.emailState === 'replied' || lead.priorityAt) return 'engaged';
  if ((lead.attempts || 0) > 0 || (lead.emailSentCount || 0) > 0) return 'contacted';
  return 'new';
}

const emailOf = lead => String(lead.email || '').trim().toLowerCase();

function initialEmailState(lead) {
  return emailOf(lead) ? 'ready' : 'none';
}

module.exports = { TERMINAL_CALL, businessKey, stageOf, emailOf, initialEmailState };
