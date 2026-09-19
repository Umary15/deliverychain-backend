const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const { ethers } = require('ethers');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

const ABI = [
    "function confirmDelivery(uint256 _id, string calldata _ipfsCID) external"
];

async function getContract() {
    const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    const wallet = new ethers.Wallet(process.env.BACKEND_WALLET_PRIVATE_KEY, provider);
    return new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, wallet);
}

// ── POST /api/otp/send ────────────────────────────────────
router.post('/send', async (req, res) => {
    try {
        const { deliveryId } = req.body;

        if (!deliveryId) {
            return res.status(400).json({ error: 'Delivery ID is required' });
        }

        const { data: delivery, error } = await supabase
            .from('deliveries')
            .select('*')
            .eq('id', deliveryId)
            .single();

        if (error || !delivery) {
            return res.status(404).json({ error: 'Delivery not found' });
        }

        if (!delivery.ipfs_hash) {
            return res.status(400).json({ error: 'Photo must be uploaded before sending OTP' });
        }

        // Generate OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        await supabase
            .from('deliveries')
            .update({ otp, otp_expires_at: otpExpiresAt })
            .eq('id', deliveryId);

        // Send email
        await resend.emails.send({
            from: 'DeliveryChain <onboarding@resend.dev>',
            to: delivery.recipient_email,
            subject: 'Your Delivery Confirmation Code',
            html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #1a5c3a;">Your package has arrived</h2>
          <p>Hello <strong>${delivery.recipient_name}</strong>,</p>
          <p>Your delivery of <strong>${delivery.item_description}</strong> is at your location.</p>
          <p>Enter this code to confirm receipt:</p>
          <div style="background: #eafaf1; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
            <span style="font-size: 40px; font-weight: bold; color: #1a5c3a; letter-spacing: 8px;">
              ${otp}
            </span>
          </div>
          <p style="color: #6b7280; font-size: 13px;">
            This code expires in 10 minutes.
            Do not share it with anyone including the rider.
          </p>
          <p style="color: #6b7280; font-size: 13px;">
  Click the link below to confirm your delivery:
</p>
<a
  href="http://localhost:5173/confirm/${delivery.id}"
  style="display: block; background: #1a5c3a; color: white; text-align: center; padding: 14px; border-radius: 10px; text-decoration: none; font-weight: bold; margin: 16px 0;"
>
  Confirm My Delivery
</a>
          <p style="color: #6b7280; font-size: 13px;">
            By entering this code you confirm the package was received.
            This action will be recorded permanently on the blockchain.
          </p>
          <p style="color: #6b7280; font-size: 13px;">
            Delivery fee: <strong>₦${Number(delivery.fee_naira).toLocaleString()}</strong>
          </p>
        </div>
      `,
        });

        res.json({ success: true, message: 'OTP sent to recipient email' });

    } catch (err) {
        console.error('Send OTP error:', err);
        res.status(500).json({ error: 'Failed to send OTP' });
    }
});

// ── POST /api/otp/verify ──────────────────────────────────
router.post('/verify', async (req, res) => {
    try {
        const { deliveryId, otp } = req.body;

        if (!deliveryId || !otp) {
            return res.status(400).json({ error: 'Delivery ID and OTP are required' });
        }

        const { data: delivery, error } = await supabase
            .from('deliveries')
            .select('*')
            .eq('id', deliveryId)
            .single();

        if (error || !delivery) {
            return res.status(404).json({ error: 'Delivery not found' });
        }

        if (delivery.otp !== otp) {
            return res.status(400).json({ error: 'Invalid OTP' });
        }

        if (new Date() > new Date(delivery.otp_expires_at)) {
            return res.status(400).json({ error: 'OTP has expired. Ask the rider to resend.' });
        }

        // Record on blockchain
        const contract = await getContract();
        const tx = await contract.confirmDelivery(
            delivery.contract_delivery_id,
            delivery.ipfs_hash
        );
        await tx.wait();

        // Update Supabase
        const updatedTxIds = { ...delivery.blockchain_tx_ids, delivered: tx.hash };
        await supabase
            .from('deliveries')
            .update({
                status: 'DELIVERED',
                otp: null,
                delivered_at: new Date().toISOString(),
                blockchain_tx_ids: updatedTxIds,
            })
            .eq('id', deliveryId);

        res.json({
            success: true,
            message: 'Delivery confirmed on blockchain',
            transactionHash: tx.hash,
        });

    } catch (err) {
        console.error('Verify OTP error:', err);
        res.status(500).json({ error: 'Failed to verify OTP' });
    }
});

module.exports = router;