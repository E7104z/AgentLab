/**
 * Google Docs proposals. Uses the mailbox owner's OAuth (same Google account).
 * Placeholders look like {{ShortName}}; filled values are bold.
 */
const { google } = require('googleapis');

/** Walks a Docs document body (including tables) and returns every text run with its start index. */
function textRuns(content, out = []) {
  for (const el of content || []) {
    if (el.paragraph) {
      for (const pe of el.paragraph.elements || []) {
        if (pe.textRun && pe.textRun.content) out.push({ start: pe.startIndex, text: pe.textRun.content });
      }
    } else if (el.table) {
      for (const row of el.table.tableRows || []) for (const cell of row.tableCells || []) textRuns(cell.content, out);
    } else if (el.tableOfContents) {
      textRuns(el.tableOfContents.content, out);
    }
  }
  return out;
}

/**
 * Builds batchUpdate requests that replace each {{Key}} with its value and bold the value.
 * Processes from the end of the document backward so earlier indexes stay valid.
 */
function placeholderRequests(doc, values) {
  const hits = [];
  for (const run of textRuns(doc.body && doc.body.content)) {
    const re = /\{\{\s*(\w+)\s*\}\}/g;
    let m;
    while ((m = re.exec(run.text))) {
      if (!(m[1] in values)) continue;
      hits.push({ start: run.start + m.index, end: run.start + m.index + m[0].length, key: m[1] });
    }
  }
  hits.sort((a, b) => b.start - a.start);
  const requests = [];
  for (const h of hits) {
    const value = String(values[h.key] ?? '');
    requests.push({ deleteContentRange: { range: { startIndex: h.start, endIndex: h.end } } });
    if (value) {
      requests.push({ insertText: { location: { index: h.start }, text: value } });
      requests.push({
        updateTextStyle: {
          range: { startIndex: h.start, endIndex: h.start + value.length },
          textStyle: { bold: true },
          fields: 'bold',
        },
      });
    }
  }
  return { requests, filled: hits.map((h) => h.key) };
}

function createDocs({ auth }) {
  const docs = google.docs({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  async function share(fileId) {
    await drive.permissions.create({ fileId, requestBody: { type: 'anyone', role: 'reader' } });
  }

  return {
    async fromTemplate({ templateId, folderId, title, values, shareWithLink }) {
      const copy = await drive.files.copy({
        fileId: templateId,
        requestBody: { name: title, parents: folderId ? [folderId] : undefined },
      });
      const docId = copy.data.id;
      const doc = await docs.documents.get({ documentId: docId });
      const { requests } = placeholderRequests(doc.data, values);
      if (requests.length) await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });
      if (shareWithLink) await share(docId);
      return { docId, url: `https://docs.google.com/document/d/${docId}/edit` };
    },

    /** Used when no template is configured: a plain document with bold values. */
    async fromScratch({ folderId, title, sections, shareWithLink }) {
      const created = await docs.documents.create({ requestBody: { title } });
      const docId = created.data.documentId;
      if (folderId) {
        const meta = await drive.files.get({ fileId: docId, fields: 'parents' });
        await drive.files.update({
          fileId: docId,
          addParents: folderId,
          removeParents: (meta.data.parents || []).join(','),
        });
      }
      const requests = [];
      let index = 1;
      const push = (text, bold) => {
        requests.push({ insertText: { location: { index }, text } });
        if (bold) {
          requests.push({
            updateTextStyle: { range: { startIndex: index, endIndex: index + text.length - 1 }, textStyle: { bold: true }, fields: 'bold' },
          });
        }
        index += text.length;
      };
      for (const s of sections) {
        push(s.label + '\n', false);
        push(s.value + '\n\n', true);
      }
      await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });
      if (shareWithLink) await share(docId);
      return { docId, url: `https://docs.google.com/document/d/${docId}/edit` };
    },
  };
}

module.exports = { createDocs, placeholderRequests, textRuns };
