import { Router } from 'express';

export default function createAuthRoutes({ createProfile, validateProfile, publicProfile }) {
  const router = Router();

  router.post('/register', (req, res) => {
    const { name, pin } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName || !/^\d{4}$/.test(String(pin || ''))) {
      return res.status(400).json({ ok: false, error: 'Magac iyo PIN sax ah geli.' });
    }
    const profile = createProfile(cleanName, String(pin));
    if (!profile) return res.status(409).json({ ok: false, error: 'Magacan hore ayuu u jiraa.' });
    return res.status(201).json({ ok: true, profile: publicProfile(profile) });
  });

  router.post('/login', (req, res) => {
    const { name, pin } = req.body || {};
    const profile = validateProfile(name, pin);
    if (!profile) return res.status(401).json({ ok: false, error: 'Magac ama PIN khaldan.' });
    return res.json({ ok: true, profile: publicProfile(profile) });
  });

  return router;
}