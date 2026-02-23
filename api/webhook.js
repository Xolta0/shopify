import { URLSearchParams } from "node:url";

// Token cache
let cachedToken = null;
let tokenExpiresAt = 0;

async function getShopifyToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;

  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  const response = await fetch(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Shopify token request failed: ${response.status} ${errText}`);
  }

  const { access_token, expires_in } = await response.json();
  cachedToken = access_token;
  tokenExpiresAt = Date.now() + expires_in * 1000;
  console.log("Shopify access token refreshed");
  return cachedToken;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify webhook secret
  const { secret, draft } = req.query;
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.error("Webhook: invalid secret");
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { orderId, amount, status, method, currency, type, createdAt } = req.body;
    console.log(`Webhook: orderId=${orderId} status=${status} amount=${amount} currency=${currency} draftId=${draft}`);

    if (status === "RECEIVED") {
      if (!draft) {
        throw new Error("No draft order ID in webhook URL");
      }
      await completeDraftOrder(draft, orderId, amount);
      console.log(`Draft order ${draft} completed for Aviagram ${orderId}`);
    } else if (status === "CANCELED") {
      console.log(`Payment ${orderId} was canceled`);
    } else if (status === "TIMEOUT") {
      console.log(`Payment ${orderId} timed out`);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(200).json({ received: true, error: error.message });
  }
}

async function completeDraftOrder(draftOrderId, aviagramOrderId, amount) {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const token = await getShopifyToken();
  const apiUrl = `https://${shop}/admin/api/2025-01`;

  console.log(`Completing draft order ${draftOrderId}...`);

  // Complete the draft order directly (payment_pending=false means it's fully paid)
  const completeRes = await fetch(
    `${apiUrl}/draft_orders/${draftOrderId}/complete.json?payment_pending=false`,
    {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    }
  );

  if (!completeRes.ok) {
    const errText = await completeRes.text();
    throw new Error(`Failed to complete draft order: ${completeRes.status} ${errText}`);
  }

  const completeData = await completeRes.json();
  const orderId = completeData.draft_order?.order_id;

  console.log(`Draft order ${draftOrderId} completed → Shopify order ${orderId}`);

  // Tag the newly created order with Aviagram info
  if (orderId) {
    await fetch(`${apiUrl}/orders/${orderId}.json`, {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        order: {
          id: orderId,
          tags: `aviagram-paid,aviagram:${aviagramOrderId}`,
          note: `Paid via Aviagram. Payment ID: ${aviagramOrderId}`,
        },
      }),
    });
  }

  return orderId;
}
