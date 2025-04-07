export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Only POST requests allowed' });
    }

    const orderData = req.body;

    try {
        const response = await fetch('https://qhvm3e-ny.myshopify.com/admin/api/2024-10/orders.json', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
            },
            body: JSON.stringify({ order: orderData }),
        });

        const data = await response.json();
        res.status(200).json(data);
    } catch (err) {
        res.status(500).json({ message: 'Error creating order', error: err.message });
    }
}
