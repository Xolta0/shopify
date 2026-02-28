import { URLSearchParams } from "node:url";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Token cache
let cachedToken = null;
let tokenExpiresAt = 0;

async function getShopifyToken() {
  // Return cached token if still valid (with 60s buffer)
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
  if (req.method === "OPTIONS") {
    Object.entries(corsHeaders).forEach(([key, val]) => res.setHeader(key, val));
    return res.status(200).end();
  }

  Object.entries(corsHeaders).forEach(([key, val]) => res.setHeader(key, val));

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const apiUrl = `https://${shop}/admin/api/2025-01`;

  try {
    const token = await getShopifyToken();
    const { items, customer, shippingAddress, discountCode } = req.body;

    // Validate required fields
    if (!items || !items.length) {
      return res.status(400).json({ error: "Cart is empty" });
    }
    if (!customer?.email) {
      return res.status(400).json({ error: "Email is required" });
    }
    if (!shippingAddress?.first_name || !shippingAddress?.last_name) {
      return res.status(400).json({ error: "First and last name are required" });
    }
    if (!shippingAddress?.address1 || !shippingAddress?.city || !shippingAddress?.country) {
      return res.status(400).json({ error: "Address, city, and country are required" });
    }

    // Build line items from cart (variant_id + quantity)
    const lineItems = items.map((item) => ({
      variant_id: item.variant_id,
      quantity: item.quantity,
    }));

    // Create draft order
    const draftOrderBody = {
      draft_order: {
        line_items: lineItems,
        email: customer.email,
        shipping_address: {
          first_name: shippingAddress.first_name,
          last_name: shippingAddress.last_name,
          address1: shippingAddress.address1,
          address2: shippingAddress.address2 || "",
          city: shippingAddress.city,
          province: shippingAddress.province || "",
          country: shippingAddress.country,
          zip: shippingAddress.zip || "",
          phone: shippingAddress.phone || "",
        },
        billing_address: {
          first_name: shippingAddress.first_name,
          last_name: shippingAddress.last_name,
          address1: shippingAddress.address1,
          address2: shippingAddress.address2 || "",
          city: shippingAddress.city,
          province: shippingAddress.province || "",
          country: shippingAddress.country,
          zip: shippingAddress.zip || "",
          phone: shippingAddress.phone || "",
        },
        // Free shipping / flat rate — set shipping line
        shipping_line: {
          title: "Standard Shipping",
          price: "0.00",
          custom: true,
        },
        note: "Awaiting Aviagram payment",
        tags: "aviagram-pending",
      },
    };

    console.log("Creating draft order...");

    const draftRes = await fetch(`${apiUrl}/draft_orders.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(draftOrderBody),
    });

    // Handle 202 (async calculation) — poll the specific draft order URL
    let draftData;
    if (draftRes.status === 202) {
      // Shopify may return the draft order in the body even with 202
      const initialData = await draftRes.json().catch(() => null);
      
      if (initialData?.draft_order?.id) {
        // Got the draft order ID, poll its specific endpoint
        const draftId = initialData.draft_order.id;
        console.log(`Draft order ${draftId} calculating, polling...`);
        
        let ready = false;
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const pollRes = await fetch(`${apiUrl}/draft_orders/${draftId}.json`, {
            headers: { 
              "X-Shopify-Access-Token": token,
              "Content-Type": "application/json",
            },
          });
          if (pollRes.status === 200) {
            const pollData = await pollRes.json();
            if (pollData.draft_order?.status !== "calculating") {
              draftData = pollData;
              ready = true;
              break;
            }
          }
          console.log(`Poll attempt ${i + 1}: still calculating...`);
        }
        if (!ready) {
          return res.status(504).json({ error: "Draft order creation timed out" });
        }
      } else {
        // No ID in response, check location header
        const location = draftRes.headers.get("location");
        if (location) {
          let ready = false;
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const pollRes = await fetch(location, {
              headers: { 
                "X-Shopify-Access-Token": token,
                "Content-Type": "application/json",
              },
            });
            if (pollRes.status === 200) {
              draftData = await pollRes.json();
              ready = true;
              break;
            }
          }
          if (!ready) {
            return res.status(504).json({ error: "Draft order creation timed out" });
          }
        } else {
          return res.status(502).json({ error: "Draft order returned 202 with no ID or location" });
        }
      }
    } else if (!draftRes.ok) {
      const errText = await draftRes.text();
      console.error("Draft order error:", draftRes.status, errText);
      
      // Parse Shopify error and return a user-friendly message
      let userMessage = "Failed to create order. Please try again.";
      try {
        const errJson = JSON.parse(errText);
        if (errJson.errors) {
          if (typeof errJson.errors === "string") {
            userMessage = errJson.errors;
          } else {
            // Format field-specific errors like {email: ["contains an invalid domain name"]}
            const messages = Object.entries(errJson.errors).map(
              ([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(", ") : msgs}`
            );
            userMessage = messages.join(". ");
          }
        }
      } catch (e) {}
      
      return res.status(422).json({ error: userMessage });
    } else {
      draftData = await draftRes.json();
    }

    const draftOrder = draftData.draft_order;
    const draftOrderId = draftOrder.id;
    const totalPrice = draftOrder.total_price;

    console.log(`Draft order created: ${draftOrderId}, total: ${totalPrice} ${draftOrder.currency}`);

    // Now create Aviagram payment
    const credentials = Buffer.from(
      `${process.env.AVIAGRAM_CLIENT_ID}:${process.env.AVIAGRAM_CLIENT_SECRET}`
    ).toString("base64");

    const aviagramBody = {
      amount: String(totalPrice),
      currency: "EUR-SP",
      originalCurrency: "GBP",
      convertCurrency: "True",
      webhook_url: `${process.env.BASE_URL}/api/webhook?secret=${process.env.WEBHOOK_SECRET}&draft=${draftOrderId}`,
    };

    const aviagramRes = await fetch("https://aviagram.app/api/payment/createForm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(aviagramBody),
    });

    if (!aviagramRes.ok) {
      const errorText = await aviagramRes.text();
      console.error("Aviagram API error:", aviagramRes.status, errorText);
      // Delete the draft order since payment couldn't be created
      await fetch(`${apiUrl}/draft_orders/${draftOrderId}.json`, {
        method: "DELETE",
        headers: { "X-Shopify-Access-Token": token },
      });
      return res.status(502).json({ error: "Payment gateway error", details: errorText });
    }

    const aviagramData = await aviagramRes.json();
    console.log(`Aviagram payment created: ${aviagramData.orderId} for draft order ${draftOrderId}`);

    // Tag draft order with Aviagram order ID for webhook matching
    await fetch(`${apiUrl}/draft_orders/${draftOrderId}.json`, {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        draft_order: {
          id: draftOrderId,
          note: `Aviagram: ${aviagramData.orderId}`,
          tags: `aviagram-pending,aviagram:${aviagramData.orderId}`,
        },
      }),
    });

    return res.status(200).json({
      success: true,
      draftOrderId,
      aviagramOrderId: aviagramData.orderId,
      redirectUrl: aviagramData.redirect_url,
      totalPrice,
      currency: draftOrder.currency,
    });
  } catch (error) {
    console.error("Checkout error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
