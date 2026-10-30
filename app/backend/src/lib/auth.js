import jwt from 'jsonwebtoken';
import { env } from './env.js';
import { query } from './db.js';

const COOKIE = 'mha_session';

export function issueSession(res, citizen) {
  const token = jwt.sign(
    { sub: String(citizen.id), mobile: citizen.mobile },
    env.jwt.secret,
    { expiresIn: env.jwt.ttlSeconds, issuer: 'mha-samadhan' },
  );

  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: 'lax',
    maxAge: env.jwt.ttlSeconds * 1000,
    path: '/',
  });

  return token;
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function readToken(req) {
  if (req.cookies && req.cookies[COOKIE]) return req.cookies[COOKIE];
  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/**
 * Attaches req.citizen when a valid session is present. Does not reject - use
 * requireCitizen for that - so public endpoints can still personalise.
 */
export async function loadCitizen(req, _res, next) {
  const token = readToken(req);
  if (!token) return next();

  try {
    const claims = jwt.verify(token, env.jwt.secret, { issuer: 'mha-samadhan' });
    const r = await query(
      'SELECT id, mobile, mobile_verified, full_name, gender, email, preferred_language FROM citizens WHERE id = $1',
      [Number(claims.sub)],
    );
    if (r.rows.length > 0) req.citizen = r.rows[0];
  } catch {
    // An expired or forged token is simply no session.
  }
  return next();
}

export function requireCitizen(req, res, next) {
  if (!req.citizen) {
    return res.status(401).json({ error: 'sign_in_required', message: 'Sign in to continue.' });
  }
  return next();
}
