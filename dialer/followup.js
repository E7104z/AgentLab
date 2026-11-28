// Follow-up email after a call: the filled template plus the CAN-SPAM footer
// (postal address and an opt-out line). Sent from the outreach mailbox the
// dialer is set to open in Gmail (settings.gmailAccount, jason@realhelpstl.com).

const { templateVars, fillTemplate } = require('./script-vars');

// Same test real-help-agent's compliance check uses: a street line plus city/state/ZIP-ish text.
function isPostalAddress(address) {
  const a = String(address || '').trim();
  return a.length >= 12 && /\d/.test(a) && /[A-Za-z]{3}/.test(a) && /,|\n/.test(a);
}

function postalAddress(s) {
  return String(s.postalAddress || process.env.DIALER_POSTAL_ADDRESS || process.env.SENDER_PHYSICAL_ADDRESS || '').replace(/\s*\n\s*/g, ', ').trim();
}

function footer(s) {
  const address = postalAddress(s);
  if (!isPostalAddress(address)) {
    const err = new Error('Add your business mailing address in Settings (Follow-up email). Federal law (CAN-SPAM) requires it at the bottom of every commercial email, so the follow-up will not open without it.');
    err.status = 400;
    throw err;
  }
  const lines = [
    '--',
    (s.senderName || '') + (s.senderCompany ? ' | ' + s.senderCompany : ''),
    address,
    '',
    'You are getting this because we spoke by phone. If you would rather not hear from me by email, reply "unsubscribe" and I will take you off my list right away.'
  ];
  if (/^https:\/\//i.test(String(s.unsubscribeUrl || ''))) lines.push('Or use this link: ' + s.unsubscribeUrl);
  return lines.join('\n');
}

function build(lead, s) {
  const vars = templateVars(lead, s);
  const subject = fillTemplate(s.emailSubject, vars);
  const body = fillTemplate(s.emailTemplate, vars).replace(/\s+$/, '') + '\n\n' + footer(s);
  return { subject, body };
}

module.exports = { build, footer, isPostalAddress, postalAddress };
