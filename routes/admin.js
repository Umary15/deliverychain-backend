const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

const ABI = [
    "function resolveDispute(uint256 _id) external",
    "function recordSettlement(uint256 _id, bool _settled) external",
];

async function getContract() {
    const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    const wallet = new ethers.Wallet(process.env.BACKEND_WALLET_PRIVATE_KEY, provider);
    return new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, wallet);
}

// ── GET /api/admin/applications ───────────────────────────
// Get all pending rider applications
router.get('/applications', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('rider_applications')
            .select('*, users!rider_applications_user_id_fkey(name, email, phone, nin)')
            .eq('status', 'PENDING')
            .order('applied_at', { ascending: false });

        if (error) {
            console.error('Applications error:', error);
            return res.status(500).json({ error: 'Failed to fetch applications' });
        }

        res.json({ success: true, applications: data });
    } catch (err) {
        console.error('Get applications error:', err);
        res.status(500).json({ error: 'Failed to fetch applications' });
    }
});

// ── POST /api/admin/applications/:id/approve ──────────────
router.post('/applications/:id/approve', async (req, res) => {
    try {
        const { id } = req.params;
        const { adminId } = req.body;

        const { data: application } = await supabase
            .from('rider_applications')
            .select('user_id')
            .eq('id', id)
            .single();

        if (!application) return res.status(404).json({ error: 'Application not found' });

        await supabase
            .from('rider_applications')
            .update({
                status: 'APPROVED',
                reviewed_by: adminId,
                reviewed_at: new Date().toISOString(),
            })
            .eq('id', id);

        await supabase
            .from('users')
            .update({ is_approved: true })
            .eq('id', application.user_id);

        res.json({ success: true, message: 'Rider approved successfully' });
    } catch (err) {
        console.error('Approve rider error:', err);
        res.status(500).json({ error: 'Failed to approve rider' });
    }
});

// ── POST /api/admin/applications/:id/reject ───────────────
router.post('/applications/:id/reject', async (req, res) => {
    try {
        const { id } = req.params;
        const { adminId } = req.body;

        const { data: application } = await supabase
            .from('rider_applications')
            .select('user_id')
            .eq('id', id)
            .single();

        if (!application) return res.status(404).json({ error: 'Application not found' });

        await supabase
            .from('rider_applications')
            .update({
                status: 'REJECTED',
                reviewed_by: adminId,
                reviewed_at: new Date().toISOString(),
            })
            .eq('id', id);

        res.json({ success: true, message: 'Rider rejected' });
    } catch (err) {
        console.error('Reject rider error:', err);
        res.status(500).json({ error: 'Failed to reject rider' });
    }
});

// ── GET /api/admin/deliveries ─────────────────────────────
router.get('/deliveries', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('deliveries')
            .select('*, sender:sender_id(name, email), rider:rider_id(name, email)')
            .order('created_at', { ascending: false });

        if (error) return res.status(500).json({ error: 'Failed to fetch deliveries' });
        res.json({ success: true, deliveries: data });
    } catch (err) {
        console.error('Get deliveries error:', err);
        res.status(500).json({ error: 'Failed to fetch deliveries' });
    }
});

// ── GET /api/admin/disputes ───────────────────────────────
router.get('/disputes', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('disputes')
            .select('*, delivery:delivery_id(*), raised_by:raised_by(name, email)')
            .eq('status', 'OPEN')
            .order('raised_at', { ascending: false });

        if (error) return res.status(500).json({ error: 'Failed to fetch disputes' });
        res.json({ success: true, disputes: data });
    } catch (err) {
        console.error('Get disputes error:', err);
        res.status(500).json({ error: 'Failed to fetch disputes' });
    }
});

// ── POST /api/admin/disputes/:id/resolve ─────────────────
router.post('/disputes/:id/resolve', async (req, res) => {
    try {
        const { id } = req.params;
        const { adminId, resolution } = req.body;

        const { data: dispute } = await supabase
            .from('disputes')
            .select('*, delivery:delivery_id(contract_delivery_id)')
            .eq('id', id)
            .single();

        if (!dispute) return res.status(404).json({ error: 'Dispute not found' });

        // Record on blockchain
        const contract = await getContract();
        const tx = await contract.resolveDispute(dispute.delivery.contract_delivery_id);
        await tx.wait();

        // Update dispute in Supabase
        await supabase
            .from('disputes')
            .update({
                status: 'RESOLVED',
                resolution,
                resolved_by: adminId,
                resolved_at: new Date().toISOString(),
            })
            .eq('id', id);

        // Update delivery status
        await supabase
            .from('deliveries')
            .update({ status: 'DELIVERED' })
            .eq('id', dispute.delivery_id);

        res.json({
            success: true,
            message: 'Dispute resolved and recorded on blockchain',
            transactionHash: tx.hash,
        });
    } catch (err) {
        console.error('Resolve dispute error:', err);
        res.status(500).json({ error: 'Failed to resolve dispute' });
    }
});

// ── POST /api/admin/deliveries/:id/settle ────────────────
router.post('/deliveries/:id/settle', async (req, res) => {
    try {
        const { id } = req.params;
        const { settled } = req.body;

        const { data: delivery } = await supabase
            .from('deliveries')
            .select('contract_delivery_id')
            .eq('id', id)
            .single();

        if (!delivery) return res.status(404).json({ error: 'Delivery not found' });

        // Record settlement on blockchain
        const contract = await getContract();
        const tx = await contract.recordSettlement(
            delivery.contract_delivery_id,
            settled
        );
        await tx.wait();

        // Update payment status in Supabase
        await supabase
            .from('deliveries')
            .update({ payment_status: settled ? 'SETTLED' : 'REFUNDED' })
            .eq('id', id);

        res.json({
            success: true,
            message: 'Settlement recorded on blockchain',
            transactionHash: tx.hash,
        });
    } catch (err) {
        console.error('Settle delivery error:', err);
        res.status(500).json({ error: 'Failed to record settlement' });
    }
});

module.exports = router;