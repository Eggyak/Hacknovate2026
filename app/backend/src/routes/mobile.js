/**
 * The contract the Android client builds against.
 *
 * One app faces two portals that were written separately and agree on almost
 * nothing: this one authenticates a citizen with a mobile number and a JWT,
 * the department authenticates staff with an access key, a password, an OTP
 * and an opaque token, and the two have different session lifetimes and
 * different ideas of what a "user" is.
 *
 * Rather than teach the app both vocabularies and let it guess which screens
 * to show, each portal describes itself here in one shape:
 *
 *   /api/mobile/manifest   public. What this portal is, how to sign in to it,
 *                          and which features are actually working right now.
 *                          The app reads it BEFORE the start screen, so it
 *                          never offers a door that is shut.
 *
 *   /api/mobile/session    authenticated. Who the holder is and what the app
 *                          should put in front of them - the modules, in
 *                          order, with the counts to badge them.
 *
 * The navigation is decided here, not in the client. Two reasons: the server
 * already enforces what each identity may do, so letting the app invent a
 * second answer guarantees they will disagree one day; and a tab the user
 * cannot actually use is worse than one that was never drawn.
 */

import { Router } from 'express';
import { env, capabilities } from '../lib/env.js';
import { requireCitizen } from '../lib/auth.js';
import { statsForCitizen } from '../services/grievances.js';
import { LANGUAGES } from '../data/languages.js';
import { DIVISIONS } from '../data/divisions.js';
import { query } from '../lib/db.js';

export const mobileRouter = Router();

/** Bumped when a field changes meaning, so an old build can refuse politely. */
export const MOBILE_API_VERSION = 1;

mobileRouter.get('/manifest', (_req, res) => {
  const caps = capabilities();

  res.json({
    portal: 'citizen',
    apiVersion: MOBILE_API_VERSION,
    title: 'MHA Samadhan',
    subtitle: 'Ministry of Home Affairs Grievance Redressal Portal',
    accent: '#0b2545',

    /*
     * How to get in. The app renders the sign-in form from this rather than
     * hard-coding fields, so a change here - a factor added or dropped - does
     * not need a new build on the Play Store.
     */
    auth: {
      kind: 'citizen',
      flow: 'otp',
      steps: [
        {
          id: 'identify',
          endpoint: 'POST /api/auth/start',
          fields: [
            { key: 'mobile', label: 'Mobile number', type: 'tel', required: true, pattern: '^[6-9][0-9]{9}$', prefix: '+91' },
            { key: 'email', label: 'Email address', type: 'email', required: true, help: 'The address on your account' },
          ],
        },
        {
          id: 'verify',
          endpoint: 'POST /api/auth/verify',
          fields: [{ key: 'code', label: 'One-time code', type: 'otp', length: 6, required: true }],
        },
      ],
      signUp: {
        endpoint: 'POST /api/auth/start',
        modeField: { mode: 'signup' },
        fields: [
          { key: 'fullName', label: 'Full name', type: 'text', required: true, minLength: 2 },
          { key: 'mobile', label: 'Mobile number', type: 'tel', required: true, pattern: '^[6-9][0-9]{9}$', prefix: '+91' },
          { key: 'gender', label: 'Gender', type: 'select', required: true, optionsFrom: 'GET /api/auth/genders' },
          { key: 'email', label: 'Email address', type: 'email', required: false, help: 'For your acknowledgment copy' },
          { key: 'consent', label: 'I confirm the particulars given are correct.', type: 'checkbox', required: true },
        ],
      },
      session: { transport: 'bearer', ttlSeconds: env.jwt.ttlSeconds, storage: 'encrypted-prefs' },
    },

    // Only ever offer a feature that is actually working on this deployment.
    capabilities: {
      voiceInput: caps.speech,
      spokenReplies: caps.speech,
      translation: caps.translation,
      assistedRouting: caps.llm,
      otpBySms: caps.smsOtp,
      departmentSync: caps.departmentSync,
      evidenceUpload: true,
      locationPin: true,
    },

    languages: LANGUAGES.map((l) => ({
      code: l.code, locale: l.locale, name: l.name, native: l.native, dir: l.dir,
      // Azure will transcribe these but will not identify them, so the app
      // must pin recognition instead of offering auto-detect. See
      // GET /api/speech/token, which returns forceLocale for exactly this.
      autoDetectable: l.lid !== false,
    })),

    divisions: DIVISIONS.map((d) => ({
      id: d.id, name: d.name, native: d.native, blurb: d.blurb,
      supplementary: Boolean(d.supplementary),
    })),

    sla: { days: env.sla.days },
    helplines: [{ label: 'Cyber Crime', number: '1930' }, { label: 'MHA', number: '1800-11-0031' }],
  });
});

/**
 * What to show this citizen, now.
 *
 * Counts come with the modules so the app can badge them in the same round
 * trip it uses to decide what to draw.
 */
mobileRouter.get('/session', requireCitizen, async (req, res, next) => {
  try {
    const stats = await statsForCitizen(req.citizen.id);
    const unread = await query(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE citizen_id = $1 AND read_at IS NULL',
      [req.citizen.id],
    );

    const profileComplete = Boolean(req.citizen.full_name && req.citizen.gender);

    res.json({
      portal: 'citizen',
      apiVersion: MOBILE_API_VERSION,
      identity: {
        id: req.citizen.id,
        displayName: req.citizen.full_name || `+91 ${req.citizen.mobile}`,
        mobile: req.citizen.mobile,
        email: req.citizen.email,
        gender: req.citizen.gender,
        verified: Boolean(req.citizen.mobile_verified),
        language: req.citizen.preferred_language,
        profileComplete,
      },

      /*
       * The navigation, in order, decided by the server.
       *
       * `requiresProfile` is why this is not a static list in the app: a
       * citizen who has not given a name and gender cannot complete a
       * filing, and showing them the button anyway only fails later, further
       * in, after they have told their story.
       */
      modules: [
        { id: 'home', label: 'Home', icon: 'home', route: '/home' },
        {
          id: 'file', label: 'Register', icon: 'mic', route: '/file',
          requiresProfile: true,
          disabledReason: profileComplete ? null : 'Add your name and gender first.',
        },
        { id: 'cases', label: 'My grievances', icon: 'folder', route: '/cases', badge: stats.active },
        { id: 'track', label: 'Track', icon: 'search', route: '/track' },
        { id: 'alerts', label: 'Updates', icon: 'bell', route: '/alerts', badge: unread.rows[0].n },
        { id: 'profile', label: 'Profile', icon: 'person', route: '/profile' },
      ],

      counts: {
        filed: stats.total,
        active: stats.active,
        resolved: stats.resolved,
        pastDue: stats.breached,
        awaitingDepartment: Number(stats.awaiting_forward || 0),
        unreadAlerts: unread.rows[0].n,
      },
    });
  } catch (err) {
    next(err);
  }
});
