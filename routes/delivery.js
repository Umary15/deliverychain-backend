const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { PinataSDK } = require('pinata');
const { ethers } = require('ethers');
const multer = require('multer');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

const pinata = new PinataSDK({
    pinataJwt: process.env.PINATA_JWT,
});

const upload = multer({ storage: multer.memoryStorage() });

const ABI = [
    "function createDelivery() external returns (uint256)",
    "function assignRider(uint256 _id) external",
    "function confirmPickup(uint256 _id) external",
    "function raiseDispute(uint256 _id) external",
];

async function getContract() {
    const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    const wallet = new ethers.Wallet(process.env.BACKEND_WALLET_PRIVATE_KEY, provider);
    return new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, wallet);
}

// ── POST /api/delivery/create ─────────────────────────────
router.post('/create', async (req, res) => {
    try {
        const {
            senderId,
            recipientName,
            recipientEmail,
            recipientPhone,
            itemDescription,
            deliveryAddress,
            feeNaira,
        } = req.body;

        if (!senderId || !recipientName || !recipientEmail || !recipientPhone || !itemDescription || !deliveryAddress || !feeNaira) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        // Record on blockchain
        const contract = await getContract();
        const tx = await contract.createDelivery();
        const receipt = await tx.wait();

        // Get contract delivery ID from logs
        let contractDeliveryId = null;
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === process.env.CONTRACT_ADDRESS.toLowerCase()) {
                contractDeliveryId = Number(log.topics[1]);
                break;
            }
        }

        if (!contractDeliveryId) {
            return res.status(500).json({ error: 'Failed to get delivery ID from blockchain' });
        }

        // Save to Supabase
        const { data, error } = await supabase
            .from('deliveries')
            .insert({
                contract_delivery_id: contractDeliveryId,
                sender_id: senderId,
                recipient_name: recipientName,
                recipient_email: recipientEmail,
                recipient_phone: recipientPhone,
                item_description: itemDescription,
                delivery_address: deliveryAddress,
                fee_naira: feeNaira,
                status: 'CREATED',
                payment_status: 'PENDING',
                blockchain_tx_ids: { created: tx.hash },
            })
            .select()
            .single();

        if (error) {
            return res.status(500).json({ error: 'Failed to save delivery' });
        }

        res.json({
            success: true,
            delivery: data,
            transactionHash: tx.hash,
        });

    } catch (err) {
        console.error('Create delivery error:', err);
        res.status(500).json({ error: 'Failed to create delivery' });
    }
});

// ── POST /api/delivery/:id/assign ────────────────────────
router.post('/:id/assign', async (req, res) => {
    try {
        const { id } = req.params;
        const { riderId } = req.body;

        const { data: delivery } = await supabase
            .from('deliveries')
            .select('*')
            .eq('id', id)
            .single();

        if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
        if (delivery.status !== 'CREATED') return res.status(400).json({ error: 'Delivery is no longer available' });

        // Record on blockchain
        const contract = await getContract();
        const tx = await contract.assignRider(delivery.contract_delivery_id);
        await tx.wait();

        // Update Supabase
        const updatedTxIds = { ...delivery.blockchain_tx_ids, assigned: tx.hash };
        await supabase
            .from('deliveries')
            .update({
                rider_id: riderId,
                status: 'ASSIGNED',
                blockchain_tx_ids: updatedTxIds,
            })
            .eq('id', id);

        res.json({
            success: true,
            message: 'Rider assigned and recorded on blockchain',
            transactionHash: tx.hash,
        });

    } catch (err) {
        console.error('Assign rider error:', err);
        res.status(500).json({ error: 'Failed to assign rider' });
    }
});

// ── POST /api/delivery/:id/pickup ─────────────────────────
router.post('/:id/pickup', async (req, res) => {
    try {
        const { id } = req.params;

        const { data: delivery } = await supabase
            .from('deliveries')
            .select('*')
            .eq('id', id)
            .single();

        if (!delivery) return res.status(404).json({ error: 'Delivery not found' });

        // Record on blockchain
        const contract = await getContract();
        const tx = await contract.confirmPickup(delivery.contract_delivery_id);
        await tx.wait();

        const updatedTxIds = { ...delivery.blockchain_tx_ids, pickedUp: tx.hash };
        await supabase
            .from('deliveries')
            .update({
                status: 'PICKED_UP',
                blockchain_tx_ids: updatedTxIds,
            })
            .eq('id', id);

        res.json({
            success: true,
            message: 'Pickup confirmed on blockchain',
            transactionHash: tx.hash,
        });

    } catch (err) {
        console.error('Confirm pickup error:', err);
        res.status(500).json({ error: 'Failed to confirm pickup' });
    }
});

// ── POST /api/delivery/upload-photo ──────────────────────
router.post('/upload-photo', upload.single('photo'), async (req, res) => {
    try {
        const { deliveryId } = req.body;

        if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
        if (!deliveryId) return res.status(400).json({ error: 'Delivery ID is required' });

        const file = new File(
            [req.file.buffer],
            req.file.originalname,
            { type: req.file.mimetype }
        );

        const uploadResult = await pinata.upload.public.file(file);
        const ipfsHash = uploadResult.cid;

        await supabase
            .from('deliveries')
            .update({ ipfs_hash: ipfsHash })
            .eq('id', deliveryId);

        res.json({
            success: true,
            ipfsHash,
            url: 'https://gateway.pinata.cloud/ipfs/' + ipfsHash,
        });

    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Photo upload failed' });
    }
});

// ── POST /api/delivery/:id/dispute ────────────────────────
router.post('/:id/dispute', async (req, res) => {
    try {
        const { id } = req.params;
        const { raisedBy, reason } = req.body;

        const { data: delivery } = await supabase
            .from('deliveries')
            .select('*')
            .eq('id', id)
            .single();

        if (!delivery) return res.status(404).json({ error: 'Delivery not found' });

        // Record on blockchain
        const contract = await getContract();
        const tx = await contract.raiseDispute(delivery.contract_delivery_id);
        await tx.wait();

        const updatedTxIds = { ...delivery.blockchain_tx_ids, disputed: tx.hash };
        await supabase
            .from('deliveries')
            .update({
                status: 'DISPUTED',
                blockchain_tx_ids: updatedTxIds,
            })
            .eq('id', id);

        await supabase
            .from('disputes')
            .insert({
                delivery_id: id,
                raised_by: raisedBy,
                reason: reason || '',
                status: 'OPEN',
            });

        res.json({
            success: true,
            message: 'Dispute raised and recorded on blockchain',
            transactionHash: tx.hash,
        });

    } catch (err) {
        console.error('Raise dispute error:', err);
        res.status(500).json({ error: 'Failed to raise dispute' });
    }
});

// ── GET /api/delivery/:id ─────────────────────────────────
router.get('/:id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('deliveries')
            .select('*, sender:sender_id(name, email), rider:rider_id(name, email, phone)')
            .eq('id', req.params.id)
            .single();

        if (error || !data) return res.status(404).json({ error: 'Delivery not found' });
        res.json({ success: true, delivery: data });

    } catch (err) {
        console.error('Get delivery error:', err);
        res.status(500).json({ error: 'Failed to fetch delivery' });
    }
});

module.exports = router;