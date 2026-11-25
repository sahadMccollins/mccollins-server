const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LINE_ITEMS = 50;
const MAX_QUANTITY = 10000;

const LIMITS = {
    email: 254,
    firstName: 100,
    lastName: 100,
    phone: 40,
    address1: 255,
    company: 150,
    city: 100,
    zip: 20,
    note: 1000,
};

function readTrimmedString(value, maxLength) {
    if (typeof value !== 'string') return null;
    return value.trim().slice(0, maxLength);
}

function parsePositiveInt(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value > 0 ? value : null;
    }
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const parsed = Number(value.trim());
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
}

/**
 * Validates and whitelists the client quote payload and returns a sanitized Shopify order object.
 */
export function validateAndBuildOrder(rawBody) {
    let body = rawBody;
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body);
        } catch {
            return { ok: false, errors: ['Request body must be valid JSON'] };
        }
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, errors: ['Request body must be a JSON object'] };
    }

    const errors = [];

    const email = readTrimmedString(body.email ?? body.customer?.email, LIMITS.email);
    if (!email || !EMAIL_REGEX.test(email)) {
        errors.push('Valid email is required');
    }

    const firstName = readTrimmedString(body.customer?.first_name, LIMITS.firstName);
    if (!firstName) {
        errors.push('customer.first_name is required');
    }

    const rawLastName = readTrimmedString(body.customer?.last_name, LIMITS.lastName);
    if (body.customer?.last_name !== undefined && body.customer?.last_name !== null && rawLastName === null) {
        errors.push('customer.last_name must be a string');
    }
    const lastName = rawLastName || 'N/A';

    const phone = readTrimmedString(
        body.phone ?? body.customer?.phone ?? body.billing_address?.phone,
        LIMITS.phone
    );
    if (!phone) {
        errors.push('phone is required');
    }

    const address1 = readTrimmedString(body.billing_address?.address1, LIMITS.address1);
    if (!address1) {
        errors.push('billing_address.address1 is required');
    }

    const rawCompany = body.billing_address?.company ?? body.company;
    const company = rawCompany === undefined || rawCompany === null
        ? ''
        : readTrimmedString(rawCompany, LIMITS.company);
    if (company === null) {
        errors.push('company must be a string');
    }

    const rawCity = body.billing_address?.city ?? body.city;
    const city = rawCity === undefined || rawCity === null
        ? ''
        : readTrimmedString(rawCity, LIMITS.city);
    if (city === null) {
        errors.push('city must be a string');
    }

    const rawZip = body.billing_address?.zip ?? body.zip;
    const parsedZip = rawZip === undefined || rawZip === null
        ? ''
        : readTrimmedString(rawZip, LIMITS.zip);
    if (parsedZip === null) {
        errors.push('zip must be a string');
    }
    const zip = parsedZip || '12345';

    const rawNote = body.note;
    const note = rawNote === undefined || rawNote === null
        ? ''
        : readTrimmedString(rawNote, LIMITS.note);
    if (note === null) {
        errors.push('note must be a string');
    }

    const sanitizedLineItems = [];
    if (!Array.isArray(body.line_items) || body.line_items.length === 0) {
        errors.push('line_items must be a non-empty array');
    } else if (body.line_items.length > MAX_LINE_ITEMS) {
        errors.push(`line_items cannot exceed ${MAX_LINE_ITEMS} items`);
    } else {
        body.line_items.forEach((item, index) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                errors.push(`line_items[${index}] must be an object`);
                return;
            }
            const variantId = parsePositiveInt(item.variant_id);
            const quantity = parsePositiveInt(item.quantity);
            if (variantId === null) {
                errors.push(`line_items[${index}].variant_id must be a positive integer`);
            }
            if (quantity === null || quantity > MAX_QUANTITY) {
                errors.push(`line_items[${index}].quantity must be an integer between 1 and ${MAX_QUANTITY}`);
            }
            if (variantId !== null && quantity !== null && quantity <= MAX_QUANTITY) {
                sanitizedLineItems.push({ variant_id: variantId, quantity });
            }
        });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    const billingAddress = {
        first_name: firstName,
        last_name: lastName,
        address1,
        zip,
        country: 'United Arab Emirates',
        phone,
    };
    if (company) billingAddress.company = company;
    if (city) billingAddress.city = city;

    const order = {
        email,
        phone,
        customer: {
            first_name: firstName,
            last_name: lastName,
        },
        billing_address: billingAddress,
        line_items: sanitizedLineItems,
    };
    if (note) order.note = note;

    return { ok: true, order };
}
