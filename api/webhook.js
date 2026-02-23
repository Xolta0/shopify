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
  const { secret } = req.query;
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.error("Webhook: invalid secret");
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { orderId, amount, status, method, currency, type, createdAt } = req.body;
    console.log(`Webhook: orderId=${orderId} status=${status} amount=${amount} currency=${currency}`);

    if (status === "RECEIVED") {
      await completeDraftOrder(orderId, amount);
      console.log(`Draft order for Aviagram ${orderId} completed successfully`);
    } else if (status === "CANCELED") {
      console.log(`Payment ${orderId} was canceled`);
    } else if (status === "TIMEOUT") {
      console.log(`Payment ${orderId} timed out`);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    // Still return 200 so Aviagram doesn't retry indefinitely
    return res.status(200).json({ received: true, error: error.message });
  }
}

async function completeDraftOrder(aviagramOrderId, amount) {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const token = await getShopifyToken();
  const apiUrl = `https://${shop}/admin/api/2025-01`;

  // Find the draft order by tag
  const listRes = await fetch(`${apiUrl}/draft_orders.json?status=open&limit=50`, {
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });

  if (!listRes.ok) {
    throw new Error(`Failed to list draft orders: ${listRes.status}`);
  }

  const listData = await listRes.json();
  const draftOrder = listData.draft_orders?.find(
    (d) =>
      d.tags?.includes(`aviagram:${aviagramOrderId}`) ||
      d.note?.includes(aviagramOrderId)
  );

  if (!draftOrder) {
    throw new Error(`No draft order found for Aviagram orderId: ${aviagramOrderId}`);
  }

  console.log(`Found draft order ${draftOrder.id} for Aviagram ${aviagramOrderId}`);

  // Complete the draft order (payment_pending=false means it's fully paid)
  const completeRes = await fetch(
    `${apiUrl}/draft_orders/${draftOrder.id}/complete.json?payment_pending=false`,
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

  console.log(`Draft order ${draftOrder.id} completed → Shopify order ${orderId}`);

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
