// D:\mccollins-server\mccollins-server\api\quote-lead.js
const axios = require('axios');

const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const PIPEDRIVE_API_BASE = 'https://api.pipedrive.com/v1';

// Helper: Find existing person by email/phone or create a new one
async function findOrCreatePerson({ name, email, phone }) {
    let personId = null;

    // 1. Search by email
    if (email) {
        try {
            const emailSearch = await axios.get(
                `${PIPEDRIVE_API_BASE}/persons/search?term=${encodeURIComponent(email)}&fields=email&exact_match=true&api_token=${PIPEDRIVE_API_TOKEN}`
            );
            const items = emailSearch.data?.data?.items;
            if (items && items.length > 0) {
                personId = items[0]?.item?.id;
            }
        } catch (e) {
            console.warn('Pipedrive Person search by email failed:', e?.response?.data || e.message);
        }
    }

    // 2. Search by phone if not found by email
    if (!personId && phone) {
        try {
            const phoneSearch = await axios.get(
                `${PIPEDRIVE_API_BASE}/persons/search?term=${encodeURIComponent(phone)}&fields=phone&exact_match=true&api_token=${PIPEDRIVE_API_TOKEN}`
            );
            const items = phoneSearch.data?.data?.items;
            if (items && items.length > 0) {
                personId = items[0]?.item?.id;
            }
        } catch (e) {
            console.warn('Pipedrive Person search by phone failed:', e?.response?.data || e.message);
        }
    }

    // 3. If no person found, create a new one
    if (!personId) {
        const personResponse = await axios.post(
            `${PIPEDRIVE_API_BASE}/persons?api_token=${PIPEDRIVE_API_TOKEN}`,
            {
                name: name,
                email: email ? [{ value: email, primary: true }] : [],
                phone: phone ? [{ value: phone, primary: true }] : []
            }
        );
        personId = personResponse.data?.data?.id;
    }

    return personId;
}

// Helper: Check if a duplicate deal was recently created for this person (last 2 minutes)
async function findRecentDeal(personId, dealTitle) {
    if (!personId) return null;
    try {
        const response = await axios.get(
            `${PIPEDRIVE_API_BASE}/persons/${personId}/deals?status=open&api_token=${PIPEDRIVE_API_TOKEN}`
        );
        const deals = response.data?.data || [];
        const twoMinutesAgo = Date.now() - 2 * 60 * 1000;

        const duplicate = deals.find((deal) => {
            const createdAt = deal.add_time ? new Date(deal.add_time).getTime() : 0;
            return deal.title === dealTitle && createdAt > twoMinutesAgo;
        });

        return duplicate ? duplicate.id : null;
    } catch (e) {
        console.warn('Pipedrive Deal duplicate check skipped:', e?.response?.data || e.message);
        return null;
    }
}

module.exports = async (req, res) => {
    // 1. Enable CORS for Shopify AJAX requests
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!PIPEDRIVE_API_TOKEN) {
        return res.status(500).json({ error: 'PIPEDRIVE_API_TOKEN is not configured on the server.' });
    }

    try {
        const {
            name,
            email,
            phone,
            company,
            event_date,
            event_type,
            emirate,
            guest_count,
            basket_items,
            message,
            source
        } = req.body || {};

        if (!name || (!email && !phone)) {
            return res.status(400).json({ error: 'Name and contact info (email or phone) are required.' });
        }

        // 2. Find or Create Person in Pipedrive (deduplication)
        const personId = await findOrCreatePerson({ name, email, phone });

        // 3. Format Deal Content & Notes
        const dealTitle = `${name} - ${event_type || 'Event Quote'} (${event_date || 'Date TBD'})`;

        let contentNotes = `<strong>Lead Source:</strong> ${source || 'Landing Page Quote Form'}<br>`;
        if (company) contentNotes += `<strong>Company:</strong> ${company}<br>`;
        if (event_date) contentNotes += `<strong>Event Date / Month:</strong> ${event_date}<br>`;
        if (event_type) contentNotes += `<strong>Event Type:</strong> ${event_type}<br>`;
        if (emirate) contentNotes += `<strong>Emirate / Venue:</strong> ${emirate}<br>`;
        if (guest_count) contentNotes += `<strong>Guest Count:</strong> ${guest_count}<br>`;
        if (message) contentNotes += `<strong>Notes:</strong> ${message}<br><br>`;

        if (basket_items && basket_items.length > 0) {
            contentNotes += `<strong>Requested Pieces / Basket:</strong><ul>`;
            basket_items.forEach((item) => {
                contentNotes += `<li>${item.name || item.title} ${item.category ? `(${item.category})` : ''} ${item.quantity ? `× ${item.quantity}` : ''}</li>`;
            });
            contentNotes += `</ul>`;
        }

        // 4. Check for duplicate deal within last 2 minutes before creating
        let dealId = await findRecentDeal(personId, dealTitle);
        let isExistingDeal = false;

        if (!dealId) {
            const dealResponse = await axios.post(
                `${PIPEDRIVE_API_BASE}/deals?api_token=${PIPEDRIVE_API_TOKEN}`,
                {
                    title: dealTitle,
                    person_id: personId,
                    status: 'open'
                }
            );
            dealId = dealResponse.data?.data?.id;
        } else {
            isExistingDeal = true;
        }

        // 5. Attach Note to Deal (only if it was just created or need to record)
        if (dealId && !isExistingDeal) {
            await axios.post(
                `${PIPEDRIVE_API_BASE}/notes?api_token=${PIPEDRIVE_API_TOKEN}`,
                {
                    deal_id: dealId,
                    content: contentNotes
                }
            );
        }

        return res.status(200).json({ 
            success: true, 
            personId: personId,
            dealId: dealId,
            isDuplicateSuppressed: isExistingDeal 
        });
    } catch (error) {
        console.error('Pipedrive Lead Creation Error:', error?.response?.data || error.message);
        return res.status(500).json({ error: 'Failed to create Pipedrive lead', details: error.message });
    }
};

