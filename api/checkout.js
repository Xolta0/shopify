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

    // Look up discount code if provided
    let appliedDiscount = null;
    if (discountCode) {
      console.log(`Looking up discount code: ${discountCode}`);
      try {
        const discountLookup = await fetch(
          `${apiUrl}/discount_codes/lookup.json?code=${encodeURIComponent(discountCode)}`,
          {
            headers: {
              "X-Shopify-Access-Token": token,
              "Content-Type": "application/json",
            },
            redirect: "follow",
          }
        );

        if (discountLookup.ok) {
          const discountData = await discountLookup.json();
          const priceRuleId = discountData.discount_code?.price_rule_id;

          if (priceRuleId) {
            const ruleRes = await fetch(`${apiUrl}/price_rules/${priceRuleId}.json`, {
              headers: {
                "X-Shopify-Access-Token": token,
                "Content-Type": "application/json",
              },
            });

            if (ruleRes.ok) {
              const ruleData = await ruleRes.json();
              const rule = ruleData.price_rule;

              const discountValue = String(Math.abs(parseFloat(rule.value)));

              appliedDiscount = {
                description: discountCode.toUpperCase(),
                value_type: rule.value_type,
                value: discountValue,
                title: discountCode.toUpperCase(),
              };

              console.log(`Discount found: ${rule.value_type} ${discountValue} (code: ${discountCode})`);
            }
          }
        } else {
          console.log(`Discount code not found or invalid: ${discountCode}`);
          return res.status(422).json({ error: `Invalid discount code: ${discountCode}` });
        }
      } catch (discountErr) {
        console.error("Discount lookup error:", discountErr);
      }
    }

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
        ...(appliedDiscount && { applied_discount: appliedDiscount }),
        shipping_line: {
          title: "Standard Shipping",
          price: "0.00",
          custom: true,
        },
        note: "Awaiting payment",
        tags: "payment-pending",
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

    // Handle 202 (async calculation)
    let draftData;
    if (draftRes.status === 202) {
      const initialData = await draftRes.json().catch(() => null);

      if (initialData?.draft_order?.id) {
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

      let userMessage = "Failed to create order. Please try again.";
      try {
        const errJson = JSON.parse(errText);
        if (errJson.errors) {
          if (typeof errJson.errors === "string") {
            userMessage = errJson.errors;
          } else {
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
    const subtotalPrice = draftOrder.subtotal_price;
    let currency = draftOrder.currency;

    // Override currency to USD for .shop domain (US market)
    const origin = req.headers.origin || req.headers.referer || '';
    if (origin.includes('.shop')) {
      currency = 'USD';
    }

    console.log(`Draft order created: ${draftOrderId}, total: ${totalPrice} ${currency}`);

    // Build redirect URL with order details
    const params = new URLSearchParams();
    params.set("draft_id", String(draftOrderId));
    params.set("email", customer.email);
    params.set("name", `${shippingAddress.first_name} ${shippingAddress.last_name}`);
    params.set("currency", currency);
    params.set("subtotal", subtotalPrice);
    params.set("total", totalPrice);

    const redirectUrl = `https://pay.zestsignal.com/payment/cda/checkout.html?${params.toString()}`;

    console.log(`Payment redirect for draft ${draftOrderId}, total: ${totalPrice} ${currency}`);

    // Tag draft order
    await fetch(`${apiUrl}/draft_orders/${draftOrderId}.json`, {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        draft_order: {
          id: draftOrderId,
          note: `Awaiting payment - Draft ${draftOrderId}`,
          tags: "payment-pending",
        },
      }),
    });

    return res.status(200).json({
      success: true,
      draftOrderId,
      redirectUrl,
      totalPrice,
      currency,
    });
  } catch (error) {
    console.error("Checkout error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
