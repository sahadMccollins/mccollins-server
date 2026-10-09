// D:\mccollins-server\mccollins-server\api\quote-lead.js
const axios = require('axios');

const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const PIPEDRIVE_API_BASE = 'https://api.pipedrive.com/v1';

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

        // 2. Create Person in Pipedrive
        const personResponse = await axios.post(
            `${PIPEDRIVE_API_BASE}/persons?api_token=${PIPEDRIVE_API_TOKEN}`,
            {
                name: name,
                email: email ? [{ value: email, primary: true }] : [],
                phone: phone ? [{ value: phone, primary: true }] : []
            }
        );
        const personId = personResponse.data?.data?.id;

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

        // 4. Create Deal in Pipedrive
        const dealResponse = await axios.post(
            `${PIPEDRIVE_API_BASE}/deals?api_token=${PIPEDRIVE_API_TOKEN}`,
            {
                title: dealTitle,
                person_id: personId,
                status: 'open'
            }
        );
        const dealId = dealResponse.data?.data?.id;

        // 5. Attach Note to Deal
        if (dealId) {
            await axios.post(
                `${PIPEDRIVE_API_BASE}/notes?api_token=${PIPEDRIVE_API_TOKEN}`,
                {
                    deal_id: dealId,
                    content: contentNotes
                }
            );
        }

        return res.status(200).json({ success: true, dealId: dealId });
    } catch (error) {
        console.error('Pipedrive Lead Creation Error:', error?.response?.data || error.message);
        return res.status(500).json({ error: 'Failed to create Pipedrive lead', details: error.message });
    }
};
