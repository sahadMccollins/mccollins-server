import mongoose from 'mongoose';

const MAX_LOG_LENGTH = 1800;

/**
 * Truncates a value (string or JSON-serializable object) to at most MAX_LOG_LENGTH chars.
 */
export function truncateMessage(value, maxLength = MAX_LOG_LENGTH) {
    let text;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value ?? null);
        } catch {
            text = String(value);
        }
    }
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
}

const statusEventSchema = new mongoose.Schema(
    {
        status: {
            type: String,
            enum: ['received', 'invalid', 'shopify_ok', 'shopify_failed', 'server_error'],
            required: true,
        },
        message: { type: String },
        httpStatus: { type: Number },
        requestId: { type: String },
        errorDetails: { type: mongoose.Schema.Types.Mixed },
        at: { type: Date, default: Date.now },
    },
    { _id: false }
);

const quoteSubmissionSchema = new mongoose.Schema(
    {
        status: {
            type: String,
            enum: ['received', 'invalid', 'shopify_ok', 'shopify_failed', 'server_error'],
            default: 'received',
            required: true,
        },
        rawSubmission: { type: mongoose.Schema.Types.Mixed },
        rawMessage: { type: String },
        shopifyOrderId: { type: mongoose.Schema.Types.Mixed },
        shopifyOrderName: { type: String },
        httpStatus: { type: Number },
        requestId: { type: String },
        errorDetails: { type: mongoose.Schema.Types.Mixed },
        statusHistory: { type: [statusEventSchema], default: [] },
    },
    { timestamps: true }
);

export function getQuoteSubmissionModel() {
    return (
        mongoose.models.QuoteSubmission ||
        mongoose.model('QuoteSubmission', quoteSubmissionSchema)
    );
}

/**
 * Connects to MongoDB using a global connection cache suited for serverless invocations.
 */
export async function connectToDatabase() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        return null;
    }

    if (!globalThis.__mongooseCache) {
        globalThis.__mongooseCache = { conn: null, promise: null };
    }
    const cache = globalThis.__mongooseCache;

    if (cache.conn) {
        return cache.conn;
    }

    if (!cache.promise) {
        cache.promise = mongoose
            .connect(uri, {
                bufferCommands: false,
                serverSelectionTimeoutMS: 5000,
            })
            .then((m) => m)
            .catch((err) => {
                cache.promise = null;
                throw err;
            });
    }

    cache.conn = await cache.promise;
    return cache.conn;
}

/**
 * Logs and saves the raw quote submission before any validation or external calls.
 * Never throws so persistence failures cannot break the HTTP request.
 */
export async function saveSubmissionReceived(rawBody) {
    const message = truncateMessage(rawBody);
    console.log('[create-order] status=received', message);

    try {
        const conn = await connectToDatabase();
        if (!conn) {
            console.warn('[create-order] MONGODB_URI not configured; skipping database save');
            return null;
        }
        const QuoteSubmission = getQuoteSubmissionModel();
        const doc = await QuoteSubmission.create({
            status: 'received',
            rawSubmission: rawBody ?? null,
            rawMessage: message,
            statusHistory: [{ status: 'received', message }],
        });
        return doc._id;
    } catch (err) {
        console.error('[create-order] failed to save received submission:', truncateMessage(err?.message || err));
        return null;
    }
}

/**
 * Logs and updates the submission status in MongoDB.
 * Never throws so persistence failures cannot break the HTTP request.
 */
export async function saveSubmissionStatus(
    submissionId,
    { status, message, httpStatus, requestId, errors, shopifyOrderId, shopifyOrderName }
) {
    const truncatedMessage = message !== undefined ? truncateMessage(message) : undefined;
    const truncatedErrors = errors !== undefined ? truncateMessage(errors) : undefined;
    const logPayload = truncateMessage({
        status,
        submissionId: submissionId ? String(submissionId) : undefined,
        httpStatus,
        requestId,
        shopifyOrderId,
        shopifyOrderName,
        message: truncatedMessage,
        errors: truncatedErrors,
    });

    if (status === 'shopify_failed' || status === 'server_error') {
        console.error(`[create-order] status=${status}`, logPayload);
    } else {
        console.log(`[create-order] status=${status}`, logPayload);
    }

    if (!submissionId) return;

    try {
        const conn = await connectToDatabase();
        if (!conn) return;
        const QuoteSubmission = getQuoteSubmissionModel();
        const updateSet = { status };
        if (httpStatus !== undefined) updateSet.httpStatus = httpStatus;
        if (requestId !== undefined) updateSet.requestId = requestId;
        if (errors !== undefined) updateSet.errorDetails = errors;
        if (shopifyOrderId !== undefined) updateSet.shopifyOrderId = shopifyOrderId;
        if (shopifyOrderName !== undefined) updateSet.shopifyOrderName = shopifyOrderName;

        const historyEntry = {
            status,
            ...(truncatedMessage !== undefined ? { message: truncatedMessage } : {}),
            ...(httpStatus !== undefined ? { httpStatus } : {}),
            ...(requestId !== undefined ? { requestId } : {}),
            ...(errors !== undefined ? { errorDetails: errors } : {}),
        };

        await QuoteSubmission.findByIdAndUpdate(submissionId, {
            $set: updateSet,
            $push: { statusHistory: historyEntry },
        });
    } catch (err) {
        console.error('[create-order] failed to update submission status:', truncateMessage(err?.message || err));
    }
}
