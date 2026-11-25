import test from 'node:test';
import assert from 'node:assert/strict';

import handler from '../api/create-order.js';
import { validateAndBuildOrder } from '../lib/order-validation.js';
import {
    clearShopifyTokenCache,
    createShopifyOrder,
    getShopifyToken,
} from '../lib/shopify.js';
import {
    getQuoteSubmissionModel,
    saveSubmissionReceived,
    saveSubmissionStatus,
    truncateMessage,
} from '../lib/quote-db.js';

function createMockRes() {
    const headers = {};
    let statusCode = 200;
    let body;
    let ended = false;

    return {
        headers,
        get statusCode() {
            return statusCode;
        },
        get body() {
            return body;
        },
        get ended() {
            return ended;
        },
        setHeader(name, value) {
            headers[name.toLowerCase()] = value;
        },
        status(code) {
            statusCode = code;
            return this;
        },
        json(payload) {
            body = payload;
            ended = true;
            return this;
        },
        end() {
            ended = true;
            return this;
        },
    };
}

function validPayload(overrides = {}) {
    return {
        email: '  client@example.com ',
        phone: ' +971501234567 ',
        note: ' Outdoor gala event ',
        customer: {
            first_name: ' Jane ',
        },
        billing_address: {
            address1: ' Dubai Design District ',
            company: ' Mint Events ',
            city: ' Dubai ',
            country: 'United States',
        },
        line_items: [
            {
                variant_id: 123456,
                quantity: 5,
                price: '0.01',
                title: 'Should be stripped',
            },
        ],
        total_price: '0.01',
        ...overrides,
    };
}

test('validateAndBuildOrder sanitizes, sets defaults, forces UAE, and strips unwhitelisted fields', () => {
    const result = validateAndBuildOrder(validPayload());
    assert.equal(result.ok, true);
    assert.deepEqual(result.order, {
        email: 'client@example.com',
        phone: '+971501234567',
        note: 'Outdoor gala event',
        customer: {
            first_name: 'Jane',
            last_name: 'N/A',
        },
        billing_address: {
            first_name: 'Jane',
            last_name: 'N/A',
            address1: 'Dubai Design District',
            company: 'Mint Events',
            city: 'Dubai',
            zip: '12345',
            country: 'United Arab Emirates',
            phone: '+971501234567',
        },
        line_items: [{ variant_id: 123456, quantity: 5 }],
    });
});

test('validateAndBuildOrder enforces required fields and line_item constraints', () => {
    assert.equal(validateAndBuildOrder(null).ok, false);
    assert.equal(validateAndBuildOrder(validPayload({ email: 'bad-email' })).ok, false);
    assert.equal(validateAndBuildOrder(validPayload({ customer: { first_name: '   ' } })).ok, false);
    assert.equal(validateAndBuildOrder(validPayload({ phone: '' })).ok, false);
    assert.equal(
        validateAndBuildOrder(validPayload({ billing_address: { address1: '' } })).ok,
        false
    );
    assert.equal(validateAndBuildOrder(validPayload({ line_items: [] })).ok, false);
    assert.equal(
        validateAndBuildOrder(
            validPayload({
                line_items: Array.from({ length: 51 }, (_, i) => ({ variant_id: i + 1, quantity: 1 })),
            })
        ).ok,
        false
    );
    assert.equal(
        validateAndBuildOrder(validPayload({ line_items: [{ variant_id: 0, quantity: 1 }] })).ok,
        false
    );
    assert.equal(
        validateAndBuildOrder(validPayload({ line_items: [{ variant_id: 10, quantity: 10001 }] })).ok,
        false
    );
    assert.equal(
        validateAndBuildOrder(validPayload({ line_items: [{ variant_id: 10, quantity: 1.5 }] })).ok,
        false
    );
});

test('truncateMessage caps output at 1800 characters', () => {
    const longText = 'x'.repeat(2500);
    const truncated = truncateMessage(longText);
    assert.equal(truncated.length, 1800);
    assert.ok(truncated.endsWith('...'));
});

test('DB persistence catches errors without breaking requests', async () => {
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/test';
    globalThis.__mongooseCache = {
        conn: { fake: true },
        promise: Promise.resolve({ fake: true }),
    };

    const model = getQuoteSubmissionModel();
    const origCreate = model.create;
    const origUpdate = model.findByIdAndUpdate;
    model.create = async () => {
        throw new Error('DB write failed');
    };
    model.findByIdAndUpdate = async () => {
        throw new Error('DB update failed');
    };

    try {
        const id = await saveSubmissionReceived({ email: 'a@b.com' });
        assert.equal(id, null);
        await saveSubmissionStatus('fake-id', {
            status: 'shopify_failed',
            httpStatus: 500,
            requestId: 'req-1',
            errors: ['boom'],
        });
    } finally {
        model.create = origCreate;
        model.findByIdAndUpdate = origUpdate;
        delete process.env.MONGODB_URI;
        delete globalThis.__mongooseCache;
    }
});

test('getShopifyToken caches token and createShopifyOrder retries once on 401/403', async () => {
    clearShopifyTokenCache();
    process.env.SHOPIFY_CLIENT_ID = 'test-client-id';
    process.env.SHOPIFY_CLIENT_SECRET = 'super-secret-value';

    let tokenCalls = 0;
    let orderCalls = 0;

    const mockFetch = async (url, init) => {
        if (url.endsWith('/admin/oauth/access_token')) {
            tokenCalls += 1;
            const parsed = JSON.parse(init.body);
            assert.equal(parsed.grant_type, 'client_credentials');
            assert.equal(parsed.client_id, 'test-client-id');
            assert.equal(parsed.client_secret, 'super-secret-value');
            return new Response(
                JSON.stringify({ access_token: `tok-${tokenCalls}`, expires_in: 86400 }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        orderCalls += 1;
        if (orderCalls === 1) {
            assert.equal(init.headers['X-Shopify-Access-Token'], 'tok-1');
            return new Response(JSON.stringify({ errors: 'Expired token' }), {
                status: 401,
                headers: { 'x-request-id': 'req-1' },
            });
        }

        assert.equal(init.headers['X-Shopify-Access-Token'], 'tok-2');
        return new Response(
            JSON.stringify({ order: { id: 999, name: '#1099' } }),
            { status: 201, headers: { 'x-request-id': 'req-2' } }
        );
    };

    const t1 = await getShopifyToken(mockFetch);
    const t2 = await getShopifyToken(mockFetch);
    assert.equal(t1, 'tok-1');
    assert.equal(t2, 'tok-1');
    assert.equal(tokenCalls, 1);

    const { response, data, requestId } = await createShopifyOrder({ email: 'a@b.com' }, mockFetch);
    assert.equal(response.status, 201);
    assert.equal(requestId, 'req-2');
    assert.equal(data.order.id, 999);
    assert.equal(tokenCalls, 2);
    assert.equal(orderCalls, 2);
});

test('handler handles CORS preflight and disallowed origins properly', async () => {
    const allowedRes = createMockRes();
    await handler(
        { method: 'OPTIONS', headers: { origin: 'https://www.minteventrentals.com' } },
        allowedRes
    );
    assert.equal(allowedRes.statusCode, 200);
    assert.equal(allowedRes.headers['vary'], 'Origin');
    assert.equal(allowedRes.headers['access-control-allow-origin'], 'https://www.minteventrentals.com');
    assert.equal(allowedRes.headers['access-control-allow-methods'], 'POST, OPTIONS');
    assert.equal(allowedRes.headers['access-control-allow-credentials'], undefined);

    const disallowedRes = createMockRes();
    await handler(
        { method: 'OPTIONS', headers: { origin: 'https://evil.example' } },
        disallowedRes
    );
    assert.equal(disallowedRes.statusCode, 200);
    assert.equal(disallowedRes.headers['vary'], 'Origin');
    assert.equal(disallowedRes.headers['access-control-allow-origin'], undefined);
});

test('handler rejects non-POST with 405 and invalid input with 400', async () => {
    const getRes = createMockRes();
    await handler({ method: 'GET', headers: {} }, getRes);
    assert.equal(getRes.statusCode, 405);

    const badRes = createMockRes();
    await handler(
        { method: 'POST', headers: { origin: 'https://minteventrentals.com' }, body: { email: 'bad' } },
        badRes
    );
    assert.equal(badRes.statusCode, 400);
    assert.equal(badRes.body.ok, false);
});

test('handler returns 200 { ok: true, order: { id, name } } on success and 502 on Shopify error', async () => {
    const originalFetch = globalThis.fetch;
    delete process.env.MONGODB_URI;
    process.env.SHOPIFY_CLIENT_ID = 'id';
    process.env.SHOPIFY_CLIENT_SECRET = 'secret';

    try {
        clearShopifyTokenCache();
        globalThis.fetch = async (url) => {
            if (url.endsWith('/admin/oauth/access_token')) {
                return new Response(JSON.stringify({ access_token: 'tok-ok', expires_in: 3600 }), {
                    status: 200,
                });
            }
            return new Response(
                JSON.stringify({
                    order: { id: 777, name: '#1777', email: 'should-not-leak@example.com' },
                }),
                { status: 201, headers: { 'x-request-id': 'req-ok' } }
            );
        };

        const okRes = createMockRes();
        await handler(
            { method: 'POST', headers: { origin: 'https://minteventrentals.com' }, body: validPayload() },
            okRes
        );
        assert.equal(okRes.statusCode, 200);
        assert.deepEqual(okRes.body, { ok: true, order: { id: 777, name: '#1777' } });

        clearShopifyTokenCache();
        globalThis.fetch = async (url) => {
            if (url.endsWith('/admin/oauth/access_token')) {
                return new Response(JSON.stringify({ access_token: 'tok-fail', expires_in: 3600 }), {
                    status: 200,
                });
            }
            return new Response(
                JSON.stringify({ errors: '[API] API Access has been disabled' }),
                { status: 403, headers: { 'x-request-id': 'req-fail' } }
            );
        };

        const failRes = createMockRes();
        await handler(
            { method: 'POST', headers: { origin: 'https://minteventrentals.com' }, body: validPayload() },
            failRes
        );
        assert.equal(failRes.statusCode, 502);
        assert.equal(failRes.body.ok, false);
        assert.equal(JSON.stringify(failRes.body).includes('API Access has been disabled'), false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('handler returns 500 when token request fails (e.g. bad client secret)', async () => {
    const originalFetch = globalThis.fetch;
    delete process.env.MONGODB_URI;
    process.env.SHOPIFY_CLIENT_ID = 'id';
    process.env.SHOPIFY_CLIENT_SECRET = 'wrong-secret';

    try {
        clearShopifyTokenCache();
        globalThis.fetch = async () =>
            new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });

        const res = createMockRes();
        await handler(
            { method: 'POST', headers: { origin: 'https://minteventrentals.com' }, body: validPayload() },
            res
        );
        assert.equal(res.statusCode, 500);
        assert.equal(res.body.ok, false);
        assert.equal(JSON.stringify(res.body).includes('wrong-secret'), false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
