/**
 * Send policy. Decides, for a validated model decision, whether a reply is:
 *   none   - never answered
 *   review - drafted for a human
 *   auto   - may be sent automatically (still subject to sendMode and the kill switch in the outbox)
 */
const NEVER_ANSWER = new Set(['vendor-or-sales-pitch', 'spam', 'personal']);
const ALWAYS_HUMAN = new Set(['billing', 'client-support', 'unclear']);
const AUTO_OK = new Set(['new-lead', 'active-conversation', 'booking']);

const SENSITIVE_RE = /\b(lawyer|attorney|legal action|lawsuit|sue|suing|refund|chargeback|charge ?back|dispute|discount|cheaper|lower (the )?price|scam|fraud|furious|unacceptable|complaint|cancel my|bbb)\b/i;

function decideRoute(decision, client, inboundText = '') {
  if (!decision) return { route: 'review', reason: 'no valid decision' };
  if (NEVER_ANSWER.has(decision.category)) return { route: 'none', reason: `category ${decision.category} is never answered` };
  if (!decision.should_respond) {
    if (decision.needs_human) return { route: 'task', reason: decision.needs_human_reason || 'model asked for a human' };
    return { route: 'none', reason: 'model chose not to respond' };
  }
  if (ALWAYS_HUMAN.has(decision.category)) return { route: 'review', reason: `category ${decision.category} always goes to a human` };
  if (decision.needs_human) return { route: 'review', reason: decision.needs_human_reason || 'model asked for a human' };
  if (SENSITIVE_RE.test(inboundText) || SENSITIVE_RE.test(decision.body || '')) return { route: 'review', reason: 'sensitive topic (money, legal or complaint)' };
  const min = typeof client.autoSendMinConfidence === 'number' ? client.autoSendMinConfidence : 0.8;
  if (decision.confidence < min) return { route: 'review', reason: `confidence ${decision.confidence} below ${min}` };
  if (!AUTO_OK.has(decision.category)) return { route: 'review', reason: `category ${decision.category} is not auto-send` };
  return { route: 'auto', reason: 'meets auto-send policy' };
}

module.exports = { decideRoute, SENSITIVE_RE, NEVER_ANSWER, ALWAYS_HUMAN };
