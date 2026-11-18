const { google } = require('googleapis');

/** Appends rows to a tab of a Google Sheet (used for the weekly scorecard). */
function createSheets({ auth }) {
  const sheets = google.sheets({ version: 'v4', auth });
  return {
    async appendRow(spreadsheetId, tab, values) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tab}!A1`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] },
      });
    },
  };
}

module.exports = { createSheets };
