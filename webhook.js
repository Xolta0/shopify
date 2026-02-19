// /api/webhook.js
// Handles Aviagram webhook callbacks for payment status updates

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
      await markShopifyOrderPaid(orderId, amount, currency);
      console.log(`Order ${orderId} marked as paid`);
    } else if (status === "CANCELED") {
      console.log(`Order ${orderId} payment canceled`);
      // Add custom cancel logic here if needed
    }

    // Return 200 so Aviagram counts it as received
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    // Still return 200 to avoid infinite retries
    return res.status(200).json({ received: true, error: "Processing failed" });
  }
}

async function markShopifyOrderPaid(aviagramOrderId, amount, currency) {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
  const apiUrl = `https://${shop}/admin/api/2024-10`;

  // Search for order by tag (we tag orders with aviagram order ID when creating payment)
  const searchRes = await fetch(
    `${apiUrl}/orders.json?status=any&limit=50`,
    {
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    }
  );

  const searchData = await searchRes.json();
  const order = searchData.orders?.find(
    (o) =>
      o.note?.includes(aviagramOrderId) ||
      o.tags?.includes(aviagramOrderId)
  );

  if (!order) {
    throw new Error(`No Shopify order found for Aviagram orderId: ${aviagramOrderId}`);
  }

  // Create a transaction to mark the order as paid
  const txRes = await fetch(
    `${apiUrl}/orders/${order.id}/transactions.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transaction: {
          kind: "capture",
          status: "success",
          amount: amount,
          currency: currency?.replace(/-.*$/, "") || "EUR",
          gateway: "Aviagram",
        },
      }),
    }
  );

  if (!txRes.ok) {
    const errText = await txRes.text();
    throw new Error(`Shopify transaction failed: ${txRes.status} ${errText}`);
  }

  console.log(`Shopify order ${order.id} marked as paid`);
}
