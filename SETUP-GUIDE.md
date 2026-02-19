# Aviagram + Shopify Integration — Step-by-Step Setup Guide

---

## What We're Building

A small backend server (hosted free on Vercel) that connects your Shopify store to the Aviagram payment gateway. When a customer clicks "Pay", they get redirected to Aviagram's payment page. After they pay, Aviagram notifies your server, and your server marks the Shopify order as paid.

---

## Prerequisites

You'll need:
- A computer with a web browser
- A GitHub account (free) — [github.com](https://github.com)
- A Vercel account (free) — [vercel.com](https://vercel.com)
- Admin access to the Shopify store
- Your Aviagram credentials (clientId and clientSecret from the Aviagram team)

---

## PART 1: Create the Project Files

### Step 1: Create a GitHub Repository

1. Go to [github.com/new](https://github.com/new)
2. Name it: `aviagram-shopify`
3. Set it to **Private**
4. Check **"Add a README file"**
5. Click **Create repository**

### Step 2: Add the Project Files

You need to create 4 files in your repo. Click **"Add file"** → **"Create new file"** for each one.

---

**File 1: `package.json`**

Click "Add file" → "Create new file" → type `package.json` as the filename, then paste:

```json
{
  "name": "aviagram-shopify",
  "version": "1.0.0",
  "private": true
}
```

Click **"Commit changes"**.

---

**File 2: `vercel.json`**

Create another new file called `vercel.json`, paste:

```json
{
  "version": 2,
  "functions": {
    "api/*.js": {
      "maxDuration": 30
    }
  }
}
```

Click **"Commit changes"**.

---

**File 3: `api/create-payment.js`**

Create a new file. In the filename field, type `api/create-payment.js` (this automatically creates the `api` folder).

Paste the entire contents of the `create-payment.js` file I gave you earlier. Then click **"Commit changes"**.

---

**File 4: `api/webhook.js`**

Create a new file called `api/webhook.js` and paste the entire contents of the `webhook.js` file I gave you. Click **"Commit changes"**.

---

Your repo should now look like this:
```
aviagram-shopify/
├── api/
│   ├── create-payment.js
│   └── webhook.js
├── package.json
├── vercel.json
└── README.md
```

---

## PART 2: Deploy to Vercel

### Step 3: Connect GitHub to Vercel

1. Go to [vercel.com](https://vercel.com) and sign up / log in (use "Continue with GitHub")
2. Click **"Add New..."** → **"Project"**
3. You'll see your GitHub repos listed. Find `aviagram-shopify` and click **"Import"**
4. **Don't change any settings yet** — just click **"Deploy"**
5. Wait for it to finish (should take ~30 seconds)
6. You'll get a URL like `https://aviagram-shopify-xxxx.vercel.app` — **copy this URL**, you'll need it!

### Step 4: Add Environment Variables

1. In your Vercel project, go to **Settings** → **Environment Variables**
2. Add each of these one by one (click "Add" after each):

| Name | Value |
|------|-------|
| `AVIAGRAM_CLIENT_ID` | Your client ID from Aviagram (ask your client or Aviagram team) |
| `AVIAGRAM_CLIENT_SECRET` | Your client secret from Aviagram |
| `SHOPIFY_STORE_DOMAIN` | `your-store.myshopify.com` (replace with actual store domain) |
| `SHOPIFY_ADMIN_API_TOKEN` | We'll get this in the next step |
| `BASE_URL` | The Vercel URL from Step 3 (e.g. `https://aviagram-shopify-xxxx.vercel.app`) |
| `WEBHOOK_SECRET` | See below how to generate this |

**To generate WEBHOOK_SECRET:**
- Go to [generate-random.org/api-key-generator](https://generate-random.org/api-key-generator)
- Generate a 256-bit key
- Copy and paste it as the value

### Step 5: Redeploy After Adding Variables

After adding all environment variables:
1. Go to **Deployments** tab in Vercel
2. Click the **three dots (⋯)** next to the latest deployment
3. Click **"Redeploy"**
4. Click **"Redeploy"** again to confirm

This ensures your app picks up the new environment variables.

---

## PART 3: Set Up Shopify

### Step 6: Create a Shopify Custom App

1. Log in to Shopify Admin
2. Go to **Settings** (bottom left) → **Apps and sales channels**
3. Click **"Develop apps"** (top right)
4. If prompted, click **"Allow custom app development"**
5. Click **"Create an app"**
6. Name it: `Aviagram Payments`
7. Click **"Create app"**

### Step 7: Configure API Permissions

1. Click **"Configure Admin API scopes"**
2. Scroll down and check these boxes:
   - ✅ `write_orders`
   - ✅ `read_orders`
3. Click **"Save"**

### Step 8: Install the App and Get the Token

1. Click the **"API credentials"** tab
2. Click **"Install app"** → **"Install"**
3. You'll see **"Admin API access token"** — click **"Reveal token once"**
4. **COPY THIS TOKEN IMMEDIATELY** — you can only see it once!
5. Go back to Vercel → Settings → Environment Variables
6. Add/update `SHOPIFY_ADMIN_API_TOKEN` with the token you just copied
7. **Redeploy** again (Deployments → ⋯ → Redeploy)

---

## PART 4: Add the Pay Button to Shopify

### Step 9: Add the Payment Button to Your Store

This depends on where you want the button. The simplest approach is adding it to a custom page or after order creation.

**Option A: Custom Payment Page**

1. In Shopify Admin, go to **Online Store** → **Pages**
2. Click **"Add page"**
3. Title: `Pay with Card`
4. Click the **`<>`** (Show HTML) button in the editor
5. Paste this code (replace YOUR_VERCEL_URL):

```html
<div id="payment-section">
  <p>Complete your payment securely below.</p>
  <button id="pay-btn" style="background-color: #000; color: #fff; padding: 12px 24px; border: none; border-radius: 6px; font-size: 16px; cursor: pointer;">
    Pay Now
  </button>
  <p id="pay-status" style="margin-top: 10px;"></p>
</div>

<script>
document.getElementById('pay-btn').addEventListener('click', async function() {
  const btn = this;
  const status = document.getElementById('pay-status');
  
  btn.disabled = true;
  btn.textContent = 'Processing...';
  status.textContent = '';

  try {
    // Get order details from URL params or however your flow works
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('order_id');
    const amount = params.get('amount');

    if (!orderId || !amount) {
      status.textContent = 'Error: Missing order details. Please go back and try again.';
      btn.disabled = false;
      btn.textContent = 'Pay Now';
      return;
    }

    const response = await fetch('YOUR_VERCEL_URL/api/create-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: orderId,
        amount: amount,
        currency: 'EUR-GT'
      })
    });

    const data = await response.json();

    if (data.redirectUrl) {
      window.location.href = data.redirectUrl;
    } else {
      status.textContent = 'Payment could not be started. Please try again.';
      btn.disabled = false;
      btn.textContent = 'Pay Now';
    }
  } catch (err) {
    status.textContent = 'Something went wrong. Please try again.';
    btn.disabled = false;
    btn.textContent = 'Pay Now';
  }
});
</script>
```

6. Click **"Save"**

**How to use it:** Direct customers to this page with the order details in the URL, like:
```
https://your-store.com/pages/pay-with-card?order_id=12345&amount=49.99
```

---

## PART 5: Test It

### Step 10: Test the Integration

1. Create a test/draft order in Shopify
2. Note the order ID and amount
3. Visit your payment page with those details:
   `https://your-store.com/pages/pay-with-card?order_id=ORDER_ID&amount=AMOUNT`
4. Click "Pay Now"
5. You should be redirected to Aviagram's payment page
6. Complete the test payment
7. Check your Shopify order — it should be marked as paid

### Troubleshooting

**"Payment could not be started" error:**
- Check Vercel logs: Go to your Vercel project → **Logs** tab
- Verify your Aviagram credentials are correct
- Make sure `BASE_URL` in Vercel env vars matches your actual Vercel URL

**Payment completes but Shopify order not updated:**
- Check Vercel logs for webhook errors
- Make sure `SHOPIFY_ADMIN_API_TOKEN` is correct
- Make sure the Shopify app has `write_orders` permission
- The order in Shopify should have the Aviagram orderId in its notes or tags for the webhook to find it

**CORS errors in browser console:**
- This should be handled already, but if issues persist, check that you're using the correct Vercel URL

---

## Quick Reference

| What | Where |
|------|-------|
| Your backend | `https://your-project.vercel.app` |
| Create payment endpoint | `POST /api/create-payment` |
| Webhook endpoint | `POST /api/webhook?secret=YOUR_SECRET` |
| Vercel logs | vercel.com → your project → Logs |
| Shopify app settings | Shopify Admin → Settings → Apps → Develop apps |

---

## Need Help?

If you get stuck on any step, send me:
1. The exact error message you see
2. A screenshot if possible
3. Which step you're on

And I'll help you through it!
