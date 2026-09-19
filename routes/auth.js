const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// ── POST /api/auth/register ───────────────────────────────
router.post('/register', async (req, res) => {
    try {
        const { email, password, name, phone, role, nin } = req.body;

        if (!email || !password || !name || !role) {
            return res.status(400).json({ error: 'Email, password, name and role are required' });
        }

        if (role === 'admin') {
            return res.status(403).json({ error: 'Cannot register as admin' });
        }

        // Create auth user in Supabase
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email,
            password,
        });

        if (authError) {
            return res.status(400).json({ error: authError.message });
        }

        const userId = authData.user.id;

        // Create user profile

        const { error: profileError } = await supabase
            .from('users')
            .insert({
                id: userId,
                email,
                name,
                phone: phone || null,
                role,
                nin: role === 'rider' ? nin : null,
                is_approved: role === 'sender' ? true : false,
            });

        if (profileError) {
            console.error('Profile insert error:', profileError);
            return res.status(500).json({ error: 'Failed to create user profile' });
        }

        // If rider, create application
        if (role === 'rider') {
            await supabase
                .from('rider_applications')
                .insert({
                    user_id: userId,
                    nin: nin || '',
                    status: 'PENDING',
                });
        }

        res.json({
            success: true,
            message: role === 'rider'
                ? 'Registration successful. Await admin approval before you can accept jobs.'
                : 'Registration successful.',
            userId,
        });

    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// ── POST /api/auth/login ──────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email,
            password,
        });

        if (authError) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Get user profile
        const { data: profile, error: profileError } = await supabase
            .from('users')
            .select('*')
            .eq('id', authData.user.id)
            .single();

        if (profileError || !profile) {
            return res.status(404).json({ error: 'User profile not found' });
        }

        res.json({
            success: true,
            user: profile,
            session: authData.session,
        });

    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

module.exports = router;