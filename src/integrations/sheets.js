const { google } = require('googleapis');

/** Reads and appends rows of a Google Sheet tab (weekly scorecard, dialer opt-out list). */
function createSheets({ auth }) {
  const sheets = google.sheets({ version: 'v4', auth });
  return {
    async readTab(spreadsheetId, tab) {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: tab });
      return r.data.values || [];
    },
    async appendRow(spreadsheetId, tab, values) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tab}!A1`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] },
      });
    },
    async appendRowValues(spreadsheetId, tab, values) {
      return this.appendRow(spreadsheetId, tab, values);
    },
  };
}

module.exports = { createSheets };
