const Stripe = require('stripe');

/**
 * Stripe wrapper. Quick Fix = one subscription Checkout with the one-time setup price
 * plus the monthly price. Custom Build = one-time payment for the amount Jason entered.
 */
function createStripe(cfg) {
  const stripe = cfg.secretKey ? new Stripe(cfg.secretKey) : null;
  return {
    available: Boolean(stripe),
    testMode: /^sk_test_/.test(cfg.secretKey || ''),
    async createCheckout({ clientId, deal, contact, offer, description }) {
      if (!stripe) throw new Error('STRIPE_SECRET_KEY is not set');
      const metadata = { client_id: clientId, deal_id: String(deal.id), contact_id: String(contact.id) };
      let session;
      if (offer === 'quick_fix') {
        if (!cfg.priceSetup || !cfg.priceMonthly) throw new Error('STRIPE_PRICE_SETUP and STRIPE_PRICE_MONTHLY must be set');
        session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer_email: contact.email,
          line_items: [
            { price: cfg.priceSetup, quantity: 1 },
            { price: cfg.priceMonthly, quantity: 1 },
          ],
          subscription_data: { metadata },
          metadata,
          success_url: cfg.successUrl,
          cancel_url: cfg.cancelUrl,
        });
      } else {
        if (!deal.amount_cents || deal.amount_cents < 100) throw new Error('Custom build needs an amount');
        session = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer_email: contact.email,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: 'usd',
                unit_amount: deal.amount_cents,
                product_data: { name: description || 'Custom Build' },
              },
            },
          ],
          payment_intent_data: { metadata },
          metadata,
          success_url: cfg.successUrl,
          cancel_url: cfg.cancelUrl,
        });
      }
      return { id: session.id, url: session.url };
    },
    /** Verifies the Stripe-Signature header against the raw body. Throws on failure. */
    constructEvent(rawBody, signature) {
      if (!stripe || !cfg.webhookSecret) throw new Error('Stripe webhook is not configured');
      return stripe.webhooks.constructEvent(rawBody, signature, cfg.webhookSecret);
    },
  };
}

module.exports = { createStripe };
