const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'qhvm3e-ny.myshopify.com';
const SHOPIFY_API_VERSION = '2024-10';

let cachedToken = { value: null, expiresAt: 0 };

/**
 * Clears the cached Shopify access token so the next call requests a fresh one.
 */
export function clearShopifyTokenCache() {
    cachedToken = { value: null, expiresAt: 0 };
}

function sanitizeTokenError(data) {
    if (!data || typeof data !== 'object') return data;
    const sanitized = { ...data };
    if ('access_token' in sanitized) sanitized.access_token = '[REDACTED]';
    if ('client_secret' in sanitized) sanitized.client_secret = '[REDACTED]';
    return sanitized;
}

/**
 * Fetches and caches a Shopify Admin API access token via client credentials grant.
 */
export async function getShopifyToken(fetchImpl = fetch) {
    if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60_000) {
        return cachedToken.value;
    }

    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET');
    }

    const res = await fetchImpl(`https://${SHOP_DOMAIN}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'client_credentials',
        }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
        throw new Error(`Token request failed: ${res.status} ${JSON.stringify(sanitizeTokenError(data))}`);
    }

    cachedToken = {
        value: data.access_token,
        expiresAt: Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600_000),
    };
    return cachedToken.value;
}

async function postOrderRequest(orderPayload, token, fetchImpl) {
    return fetchImpl(`https://${SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/orders.json`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
        },
        body: JSON.stringify({ order: orderPayload }),
    });
}

/**
 * Posts a validated order payload to Shopify Admin REST API, retrying once on 401/403
 * with a refreshed OAuth token.
 */
export async function createShopifyOrder(orderPayload, fetchImpl = fetch) {
    let token = await getShopifyToken(fetchImpl);
    let response = await postOrderRequest(orderPayload, token, fetchImpl);

    if (response.status === 401 || response.status === 403) {
        clearShopifyTokenCache();
        token = await getShopifyToken(fetchImpl);
        response = await postOrderRequest(orderPayload, token, fetchImpl);
    }

    const data = await response.json().catch(() => ({}));
    const requestId = response.headers?.get?.('x-request-id') || null;

    return { response, data, requestId };
}
