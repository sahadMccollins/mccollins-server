const express = require('express');
const app = express();
app.use(cors());
app.use(express.json());

app.post('/create-order', async (req, res) => {
    console.log("reached", req.body)
    // return
    const orderData = req.body;

    const response = await fetch('https://qhvm3e-ny.myshopify.com/admin/api/2024-10/orders.json', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': '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',
        },
        body: JSON.stringify({
            order: orderData
        }),
    });

    const data = await response.json();
    console.log("data", data)
    res.json(data);
});

app.listen(3000, () => console.log('Server running on port 3000'));