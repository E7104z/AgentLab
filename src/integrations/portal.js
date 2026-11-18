/**
 * Creates a client login in the-real-help's portal by writing an inviteRequests doc,
 * which the portal's existing onInviteRequest Cloud Function turns into a Firebase Auth user + invite.
 * Off unless PORTAL_INVITE_ENABLED=true and a service account is provided.
 */
function createPortal(cfg) {
  if (!cfg.enabled || !cfg.serviceAccountJson) {
    return { available: false, async invite() { throw new Error('portal invites are not enabled'); } };
  }
  const admin = require('firebase-admin');
  const credentials = JSON.parse(cfg.serviceAccountJson);
  const app = admin.initializeApp({ credential: admin.credential.cert(credentials) }, 'portal');
  const firestore = app.firestore();
  return {
    available: true,
    async invite({ name, email, service }) {
      const ref = await firestore.collection('inviteRequests').add({
        name,
        email,
        service,
        requestedBy: 'agentlab',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { id: ref.id };
    },
  };
}

module.exports = { createPortal };
