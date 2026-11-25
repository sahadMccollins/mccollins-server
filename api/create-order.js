import { createShopifyOrder } from '../lib/shopify.js';
import { validateAndBuildOrder } from '../lib/order-validation.js';
import { saveSubmissionReceived, saveSubmissionStatus } from '../lib/quote-db.js';

const ALLOWED_ORIGINS = new Set([
    'https://minteventrentals.com',
    'https://www.minteventrentals.com',
]);

function applyCors(req, res) {
    const origin = req.headers?.origin;
    res.setHeader('Vary', 'Origin');
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Only POST requests allowed' });
    }

    // Save raw submission first before validation or calling Shopify
    const submissionId = await saveSubmissionReceived(req.body);

    try {
        const validation = validateAndBuildOrder(req.body);
        if (!validation.ok) {
            await saveSubmissionStatus(submissionId, {
                status: 'invalid',
                httpStatus: 400,
                errors: validation.errors,
                message: validation.errors.join('; '),
            });
            return res.status(400).json({
                ok: false,
                error: 'Invalid order submission',
                details: validation.errors,
            });
        }

        const { response, data, requestId } = await createShopifyOrder(validation.order);

        if (!response.ok || data?.errors || !data?.order?.id) {
            await saveSubmissionStatus(submissionId, {
                status: 'shopify_failed',
                httpStatus: response.status,
                requestId,
                errors: data?.errors ?? data,
                message: `Shopify HTTP ${response.status}`,
            });
            return res.status(502).json({
                ok: false,
                error: 'Unable to submit quote order right now. Please try again.',
            });
        }

        await saveSubmissionStatus(submissionId, {
            status: 'shopify_ok',
            httpStatus: response.status,
            requestId,
            shopifyOrderId: data.order.id,
            shopifyOrderName: data.order.name,
            message: `Created order ${data.order.name || data.order.id}`,
        });

        return res.status(200).json({
            ok: true,
            order: {
                id: data.order.id,
                name: data.order.name,
            },
        });
    } catch (err) {
        await saveSubmissionStatus(submissionId, {
            status: 'server_error',
            httpStatus: 500,
            message: err?.message || 'Unexpected server error',
        });
        return res.status(500).json({
            ok: false,
            error: 'Internal server error',
        });
    }
}
