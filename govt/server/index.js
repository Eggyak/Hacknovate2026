import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  createChallengeTable, accessKeyRequired, accessKeyValid,
  issueChallenge, verifyChallenge, sweepChallenges, deliverCode,
} from './staffAuth.js';
import { join, resolve } from 'node:path';
import {
  db, divisions, permissions, accessLevelPermissionGrants, seedDatabase, toRole, toUser, toTicket,
  getUserById, getRoleById, publicUserQuery, userByEmail, rolesList, wardsList,
  usersList, userDirectoryList, eventsList, ticketById, getWardById,
} from './db.js';

seedDatabase();
createChallengeTable(db);
setInterval(()=>{try{sweepChallenges(db);}catch(e){console.error('[auth] challenge sweep',e.message);}},10*60*1000).unref();
const app=express();
const port=Number(process.env.API_PORT??3001);
// Loopback is right for the local prototype and wrong inside a container,
// where nothing outside the namespace could then reach it. Default is
// unchanged so START_MHA_DASHBOARD.bat behaves exactly as before.
const host=process.env.API_HOST??'127.0.0.1';
// Declared here, not beside the intake limiters: `const` is not hoisted and
// the sign-in routes above those would hit the temporal dead zone.
/*
 * A ceiling on sign-in attempts per IP, not a throttle on staff.
 *
 * Thirty in fifteen minutes was far too tight: a department office behind one
 * NAT would trip it at nine in the morning, and the RBAC suite - which signs
 * in as every role in turn - tripped it immediately. The real defence against
 * guessing is elsewhere and stronger: bcrypt makes each attempt expensive,
 * the access key is checked before the password, and the one-time code has
 * its own per-challenge attempt ceiling. This is only here to stop a flood.
 */
const loginLimiter=rateLimit({windowMs:15*60*1000,limit:Number(process.env.LOGIN_RATE_LIMIT??300),standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many sign-in attempts. Try again shortly.'}});

const cookieName='mha_session';
const sessionLifetime=8*60*60*1000;
app.disable('x-powered-by');
app.use(helmet({crossOriginResourcePolicy:{policy:'same-site'},contentSecurityPolicy:false}));
app.use(express.json({limit:'256kb'}));

const hash=value=>createHash('sha256').update(value).digest('hex');
function parseCookie(req,name){const item=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(`${name}=`));return item?decodeURIComponent(item.slice(name.length+1)):null;}
function sessionToken(req){const match=String(req.headers.authorization??'').match(/^Bearer\s+(.+)$/i);return match?.[1]??null;}
function sessionUser(req){const token=sessionToken(req);if(!token)return null;const row=db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token),Date.now());if(!row)return null;const user=toUser(getUserById.get(row.user_id));if(!user?.isActive)return null;return user;}
function requireAuth(req,res,next){const user=sessionUser(req);if(!user)return res.status(401).json({error:'Sign in is required.'});const credentials=getUserById.get(user.id);const allowedDuringPasswordChange=['/api/auth/change-password','/api/auth/logout'];if(credentials?.must_change_password&&!allowedDuringPasswordChange.includes(req.originalUrl.split('?')[0]))return res.status(403).json({error:'Change your temporary password before using the workspace.'});req.user=user;req.role=toRole(getRoleById.get(user.roleId));if(!req.role)return res.status(403).json({error:'No active role is assigned to this account.'});next();}
function requirePermission(permission){return (req,res,next)=>{if(!req.role.permissions.includes(permission))return res.status(403).json({error:`The ${permission} permission is required.`});next();};}
function requireSuperAdmin(req,res,next){if(req.user.roleId!=='ROLE-SUPER-ADMIN')return res.status(403).json({error:'Super Admin access is required.'});next();}
function allowedWardIds(req){if(req.role.scopeType!=='WARD')return [];const assigned=req.user.assignedWards;if(req.role.wardIds?.length)return assigned.filter(id=>req.role.wardIds.includes(id));return assigned;}
function ticketScope(req){const clauses=[];const params=[];if(req.user.roleId!=='ROLE-SUPER-ADMIN'&&req.role.scopeType==='GLOBAL')clauses.push('1=0');if(req.role.scopeType==='DIVISION'){if(!req.role.divisionId)clauses.push('1=0');else{clauses.push('division_id=?');params.push(req.role.divisionId);}}if(req.role.scopeType==='WARD'){const ids=allowedWardIds(req);if(!ids.length)clauses.push('1=0');else{clauses.push(`ward_id IN (${ids.map(()=>'?').join(',')})`);params.push(...ids);}}if(req.role.divisionId){clauses.push('division_id=?');params.push(req.role.divisionId);}if(req.role.accessLevel==='APPELLATE_AUTHORITY')clauses.push("json_extract(payload_json,'$.appealStatus')='APPEALED'");return {sql:clauses.length?` WHERE ${clauses.join(' AND ')}`:'',params};}
function canSeeTicket(req,ticket){if(!req.role.permissions.includes('tickets:read'))return false;if(req.user.roleId!=='ROLE-SUPER-ADMIN'&&req.role.scopeType==='GLOBAL')return false;if(req.role.scopeType==='WARD'&&!allowedWardIds(req).includes(ticket.ward_id))return false;if(req.role.scopeType==='DIVISION'&&(!req.role.divisionId||req.role.divisionId!==ticket.division_id))return false;if(req.role.divisionId&&req.role.divisionId!==ticket.division_id)return false;if(req.role.accessLevel==='APPELLATE_AUTHORITY'&&JSON.parse(ticket.payload_json).appealStatus!=='APPEALED')return false;return req.role.scopeType==='GLOBAL'||req.role.scopeType==='DIVISION'||req.role.scopeType==='WARD';}
const sensitiveKeys=new Set(['details','evidence','attachments','transactionId','utrNumber','amountLost','stolenAmount','fraudDateTime','fraudDateTimeLocal','platformUsed','targetPlatform','suspectDetails','upiId','fraudsterPhone','bankAccountNumber','passportNumber','applicationReferenceNumber','visaOciReference','nationality','countryOfOrigin','visaType','issueDate','expiryDate','aadhaarNumber','bankAccountDetails','disasterName','damageCategory','lossCategory','specificUt','targetUtName','civicDepartment','wardOrZoneNumber','localityNumber','propertyId','ppoNumber','bankBranch','ifsc','freedomFighterName','primaryBeneficiary','sanctionDate','forceName','officerName','officerRank','badgeNumber','incidentLocation','misconductType','ngoName','fcraRegistrationNumber','fcraLicenseNumber','headquarterState','registrationDistrict','remittanceDetails','foreignRemittanceDetails','violationNature','threatLevel','suspectUrl','suspectWebsite','armsLicenseNumber','tipOffDetails','suspectOrganization','supportingEvidence']);
function scrubDynamic(value){if(Array.isArray(value))return value.map(scrubDynamic);if(!value||typeof value!=='object')return value;return Object.fromEntries(Object.entries(value).filter(([key])=>!sensitiveKeys.has(key)).map(([key,item])=>[key,scrubDynamic(item)]));}
function ticketForRole(row,req){const ticket=toTicket(row);if(!ticket||req.user.roleId==='ROLE-SUPER-ADMIN'||(req.role.divisionId&&req.role.divisionId===ticket.divisionId))return ticket;return scrubDynamic(ticket);}
function scopedActivities(req){
  const rows=eventsList.all();
  if(req.user.roleId==='ROLE-SUPER-ADMIN')return rows.map(row=>activityJson(row));
  const divisionId=req.role.divisionId;
  return rows.filter(row=>{
    if(req.role.accessLevel==='L1_RESOLVING_OFFICER')return row.user_id===req.user.id;
    if(req.role.accessLevel==='APPELLATE_AUTHORITY')return Boolean(row.ticket_division_id===divisionId&&row.ticket_appealed);
    if(req.role.accessLevel==='OTHER_CASE_TRIAGE')return row.ticket_division_id==='OTHER_TRIAGE'||row.actor_division_id==='OTHER_TRIAGE';
    return Boolean(divisionId&&(row.ticket_division_id===divisionId||row.actor_division_id===divisionId||safeJson(row.details_json).divisionId===divisionId));
  }).map(row=>activityJson(row));
}
const safeJson=value=>{try{return JSON.parse(value??'{}');}catch{return {};}};
const activityJson=row=>({id:row.id,userId:row.user_id,ticketId:row.ticket_id,grievanceId:row.grievance_id,actorName:row.actor_name,type:row.event_type,summary:row.summary,details:safeJson(row.details_json),createdAt:row.created_at});
function audit(userId,type,summary,ticketId=null,details={}){db.prepare('INSERT INTO activity_events(user_id,ticket_id,event_type,summary,details_json,created_at) VALUES(?,?,?,?,?,?)').run(userId,ticketId,type,summary,JSON.stringify(details),new Date().toISOString());}
const publicAccount=row=>({id:row.id,name:row.name,email:row.email,mobileNumber:row.mobile_number,roleId:row.role_id,assignedWards:JSON.parse(row.assigned_wards_json),isActive:Boolean(row.is_active),avatarInitials:row.avatar_initials,...(row.last_sign_in?{lastSignIn:row.last_sign_in}:{}),...(row.password_reset_at?{passwordResetAt:row.password_reset_at}:{})});
const userRole=(user)=>toRole(getRoleById.get(user.roleId));

app.get('/api/health',(_req,res)=>res.json({status:'ok',database:'sqlite',syntheticData:false}));
app.get('/api/auth/setup-status',(_req,res)=>res.json({needsInitialAdmin:usersList.all().length===0}));
app.post('/api/auth/initial-admin',rateLimit({windowMs:60*60*1000,limit:5,standardHeaders:'draft-8',legacyHeaders:false}), (req,res)=>{
  if(usersList.all().length!==0)return res.status(409).json({error:'Initial administrator setup has already been completed.'});
  const name=String(req.body?.name??'').trim();const email=String(req.body?.email??'').trim().toLowerCase();const mobile=String(req.body?.mobileNumber??'').trim();const password=String(req.body?.password??'');
  if(name.length<2||name.length>100||!/^\S+@\S+\.\S+$/.test(email)||mobile.length<7||mobile.length>30||password.length<8||password.length>200)return res.status(400).json({error:'Enter a name, valid email, phone, and password of at least 8 characters.'});
  const role=db.prepare("SELECT id FROM roles WHERE id='ROLE-SUPER-ADMIN'").get();if(!role)return res.status(503).json({error:'Administrator role is unavailable.'});
  const id=`USER-${randomUUID()}`;const initials=name.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase();const hashPassword=bcrypt.hashSync(password,12);
  try{db.transaction(()=>{if(usersList.all().length!==0)throw Object.assign(new Error('Initial administrator setup has already been completed.'),{code:'INITIAL_ADMIN_EXISTS'});db.prepare('INSERT INTO users(id,name,email,mobile_number,password_hash,role_id,assigned_wards_json,is_active,avatar_initials,must_change_password) VALUES(?,?,?,?,?,?,?,?,?,0)').run(id,name,email,mobile,hashPassword,role.id,'[]',1,initials);audit(id,'INITIAL_ADMIN_CREATED',`${name} completed first administrator setup.`);}).immediate();res.status(201).json({ok:true});}catch(error){if(error.code==='INITIAL_ADMIN_EXISTS')return res.status(409).json({error:error.message});if(error.code==='SQLITE_CONSTRAINT_UNIQUE')return res.status(409).json({error:'An account with that email already exists.'});throw error;}
});
/*
 * Staff sign-in, in two steps.
 *
 * Step one proves three things: a departmental access key issued out of band,
 * then the account, then the password. The key is checked FIRST so a stolen
 * password is never even tested against an account unless the person already
 * holds something they were given separately.
 *
 * Step two proves possession of the address on the staff record. That is what
 * turns a leaked password into a dead end - the code goes where the account
 * says it goes, not where the person signing in asks.
 *
 * The response to step one says nothing about which factor failed. Telling a
 * caller "wrong key" versus "wrong password" hands them a way to enumerate
 * both separately.
 */
app.post('/api/auth/login',loginLimiter,async(req,res)=>{
  const email=String(req.body?.email??'').trim().toLowerCase();
  const password=String(req.body?.password??'');
  const accessKey=String(req.body?.accessKey??'');
  if(email.length>254||password.length>200||!email||!password)return res.status(400).json({error:'Enter your department email and password.'});
  if(accessKeyRequired()&&!accessKey)return res.status(400).json({error:'The departmental access key is required.',accessKeyRequired:true});

  const keyOk=accessKeyValid(accessKey);
  const row=userByEmail.get(email);
  const dummy='$2b$10$3TtZ0N45oW2GLTtStTa/xOYKYmNdFK31yRqt6A3eAuR6wsHBmXOIG';
  // Always run the password comparison so the reply takes the same time
  // whether or not the account exists.
  const valid=bcrypt.compareSync(password,row?.password_hash??dummy);
  if(!keyOk||!row||!row.is_active||!valid)return res.status(401).json({error:'Those sign-in details were not accepted.'});

  const role=toRole(getRoleById.get(row.role_id));
  if(!role)return res.status(403).json({error:'No active role is assigned to this account.'});

  /*
   * If there is no way to deliver a code, do not demand one.
   *
   * Requiring a second factor that physically cannot be sent does not make
   * the workspace safer - it makes it unusable, which is how a local
   * prototype run from START_MHA_DASHBOARD.bat would lock its own operator
   * out. The access key above still applies, and the moment a delivery
   * channel is configured the code becomes mandatory again.
   */
  if(!process.env.N8N_OTP_WEBHOOK_URL){
    const token=randomBytes(32).toString('base64url');const expires=Date.now()+sessionLifetime;const now=new Date().toISOString();
    db.transaction(()=>{
      db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hash(token),row.id,expires,Date.now());
      db.prepare('UPDATE users SET last_sign_in=? WHERE id=?').run(now,row.id);
      audit(row.id,'SIGN_IN',`${row.name} signed in (no one-time code channel configured).`);
    })();
    const user=toUser(getUserById.get(row.id));
    return res.json({user,role,mustChangePassword:Boolean(row.must_change_password),token});
  }

  const challenge=issueChallenge(db,row.id);
  const delivery=await deliverCode({code:challenge.code,email:row.email,mobile:row.mobile_number,name:row.name});
  audit(row.id,'SIGN_IN_CHALLENGE',`One-time code issued for ${row.email}.`);

  res.json({
    otpRequired:true,
    challengeId:challenge.challengeId,
    expiresInSeconds:challenge.expiresInSeconds,
    sentTo:maskEmail(row.email),
    delivered:delivery.delivered,
    channel:delivery.channel??null,
    deliveryIssue:delivery.delivered?null:(delivery.reason??'delivery_failed'),
  });
});

function maskEmail(address){
  const [user,domain]=String(address??'').split('@');
  if(!domain)return '';
  const head=user.slice(0,2);
  return `${head}${'*'.repeat(Math.max(1,user.length-2))}@${domain}`;
}

/** Step two: the code. A session is issued only here. */
app.post('/api/auth/login/verify',loginLimiter,(req,res)=>{
  const result=verifyChallenge(db,req.body?.challengeId,req.body?.code);
  if(!result.ok)return res.status(401).json({error:result.error});

  const row=getUserById.get(result.userId);
  if(!row||!row.is_active)return res.status(401).json({error:'That account is no longer active.'});
  const role=toRole(getRoleById.get(row.role_id));
  if(!role)return res.status(403).json({error:'No active role is assigned to this account.'});

  const token=randomBytes(32).toString('base64url');const expires=Date.now()+sessionLifetime;const now=new Date().toISOString();
  db.transaction(()=>{
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hash(token),row.id,expires,Date.now());
    db.prepare('UPDATE users SET last_sign_in=? WHERE id=?').run(now,row.id);
    audit(row.id,'SIGN_IN',`${row.name} signed in.`);
  })();
  const user=toUser(getUserById.get(row.id));
  res.json({user,role,mustChangePassword:Boolean(row.must_change_password),token});
});

/** Does this deployment ask for an access key? The form needs to know. */
app.get('/api/auth/policy',(_req,res)=>res.json({
  accessKeyRequired:accessKeyRequired(),
  otpRequired:Boolean(process.env.N8N_OTP_WEBHOOK_URL),
}));

app.get('/api/auth/me',requireAuth,(req,res)=>res.json({user:req.user,role:req.role}));
app.post('/api/auth/logout',requireAuth,(req,res)=>{const token=sessionToken(req);db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));audit(req.user.id,'SIGN_OUT',`${req.user.name} signed out.`);res.json({ok:true});});
app.post('/api/auth/change-password',requireAuth,(req,res)=>{const current=String(req.body?.currentPassword??'');const next=String(req.body?.newPassword??'');if(next.length<8||next.length>200)return res.status(400).json({error:'New password must contain at least 8 characters.'});const row=getUserById.get(req.user.id);if(!bcrypt.compareSync(current,row.password_hash))return res.status(400).json({error:'Current password is incorrect.'});db.transaction(()=>{db.prepare('UPDATE users SET password_hash=?,must_change_password=0,password_reset_at=NULL WHERE id=?').run(bcrypt.hashSync(next,12),req.user.id);audit(req.user.id,'PASSWORD_CHANGED','Account password changed.');})();res.json({ok:true});});
app.post('/api/auth/forgot-password',(req,res)=>{const email=String(req.body?.email??'').trim().toLowerCase();if(email.length>254||!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({error:'Enter a valid department email.'});const row=userByEmail.get(email);if(row?.is_active)audit(row.id,'PASSWORD_RECOVERY_REQUESTED','Password recovery requested.');res.json({message:'If this active account exists, a password reset request has been recorded. Contact your Super Admin to issue a new temporary password.'});});

app.get('/api/bootstrap',requireAuth,(req,res)=>{
  const scope=ticketScope(req);const tickets=req.role.permissions.includes('tickets:read')?db.prepare(`SELECT * FROM tickets${scope.sql} ORDER BY submission_timestamp DESC LIMIT 500`).all(...scope.params).map(row=>ticketForRole(row,req)):[];
  const roles=req.user.roleId==='ROLE-SUPER-ADMIN'?rolesList.all().map(toRole):[req.role];const wards=wardsList.all();const users=req.user.roleId==='ROLE-SUPER-ADMIN'?usersList.all().map(publicAccount):[];
  const activities=req.role.permissions.includes('analytics:view')?scopedActivities(req):[];
  res.json({user:req.user,role:req.role,tickets,roles,users,wards,activities});
});
app.get('/api/tickets',requireAuth,requirePermission('tickets:read'),(req,res)=>{const scope=ticketScope(req);res.json(db.prepare(`SELECT * FROM tickets${scope.sql} ORDER BY submission_timestamp DESC LIMIT 500`).all(...scope.params).map(row=>ticketForRole(row,req)));});
/*
 * Two intake limits, because there are two kinds of caller.
 *
 * The 20-per-IP-per-hour ceiling is right for anonymous public submissions
 * and badly wrong for the citizen portal, which is a single IP carrying
 * everybody. Left as it was, the whole country would have been throttled at
 * twenty complaints an hour - and it was: a ward lookup returned 429 and a
 * real complaint went unforwarded.
 *
 * A caller holding the shared service key is a different trust class: it is
 * an authenticated service, not an unknown browser, and it already validated
 * and stored the complaint before forwarding it. It gets its own, much
 * larger budget. Anonymous callers are unaffected.
 */
const anonymousIntakeLimiter=rateLimit({windowMs:60*60*1000,limit:20,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Intake limit reached. Please try again later.'}});
const serviceIntakeLimiter=rateLimit({windowMs:60*60*1000,limit:2000,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Service intake limit reached.'}});

function hasServiceKey(req){
  const expected=process.env.MHA_INTAKE_SERVICE_KEY??'';
  if(!expected)return false;
  const given=String(req.get('x-service-key')??'');
  const a=createHash('sha256').update(given).digest();
  const b=createHash('sha256').update(expected).digest();
  return timingSafeEqual(a,b);
}

// Pick the limiter from who is calling, before either one counts the request.
const intakeLimiter=(req,res,next)=>(hasServiceKey(req)?serviceIntakeLimiter:anonymousIntakeLimiter)(req,res,next);

// Read-only and key-gated, so they never share the public submission budget.
const serviceReadLimiter=rateLimit({windowMs:60*60*1000,limit:2000,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Service read limit reached.'}});
const categoryDivisions=Object.fromEntries(divisions.map(([divisionId,,category])=>[category,divisionId]));
/*
 * The contract the Android client builds against.
 *
 * Mirrors /api/mobile on the citizen portal, so one app can read both with
 * the same code and only the contents differ. The important difference is
 * here: a citizen's app looks the same for everyone, and a staff app must
 * not. A Ward Desk Officer and a Staff Admin are different jobs, and the
 * modules below are derived from the role the SERVER resolved - never from
 * anything the client claims.
 *
 * Hiding a control in an app is not access control; every route is still
 * authorised on its own. This exists so the app does not draw a queue the
 * officer will be refused from, which is a worse experience than not showing
 * it and is how people conclude a system is broken.
 */
const MOBILE_API_VERSION=1;

app.get('/api/mobile/manifest',(_req,res)=>{
  res.json({
    portal:'department',
    apiVersion:MOBILE_API_VERSION,
    title:'MHA Samadhan — Department Workspace',
    subtitle:'Grievance Operations & Management',
    accent:'#0a1220',
    auth:{
      kind:'staff',
      flow:'key-password-otp',
      // The app renders the form from this, so adding or dropping a factor
      // does not require a new build.
      steps:[
        {id:'credentials',endpoint:'POST /api/auth/login',fields:[
          ...(accessKeyRequired()?[{key:'accessKey',label:'Departmental access key',type:'password',required:true,help:'Issued to your department separately. Not your password.'}]:[]),
          {key:'email',label:'Department email / Login ID',type:'email',required:true},
          {key:'password',label:'Password',type:'password',required:true},
        ]},
        ...(process.env.N8N_OTP_WEBHOOK_URL?[{id:'verify',endpoint:'POST /api/auth/login/verify',fields:[
          {key:'code',label:'One-time code',type:'otp',length:6,required:true,help:'Sent to the address on your staff record.'},
        ]}]:[]),
      ],
      accessKeyRequired:accessKeyRequired(),
      otpRequired:Boolean(process.env.N8N_OTP_WEBHOOK_URL),
      session:{transport:'bearer',ttlSeconds:Math.round(sessionLifetime/1000),storage:'encrypted-prefs'},
      selfSignUp:false,
      note:'Staff accounts are created by a Staff Admin. There is no public registration.',
    },
    capabilities:{
      translation:Boolean(process.env.AZURE_TRANSLATOR_KEY),
      textSize:true,
      citizenIntake:true,
      evidenceUpload:false,
    },
    languages:PORTAL_LANGUAGES,
    divisions:divisions.map(([id,name,category])=>({id,name,category})),
  });
});

/**
 * What this officer should see.
 *
 * Modules are derived from the resolved role's permissions and access level.
 * toRole() has already stripped any permission above the level's ceiling, so
 * what is read here is what the server will actually honour.
 */
app.get('/api/mobile/session',requireAuth,(req,res)=>{
  const role=req.role;
  const can=(p)=>role.permissions.includes(p);
  const level=role.accessLevel;

  const scopeLabel=
    role.scopeType==='GLOBAL'?'All divisions and wards':
    role.scopeType==='DIVISION'?`${(divisions.find(([id])=>id===role.divisionId)||[,role.divisionId])[1]}`:
    `${(req.user.assignedWards||[]).length||role.wardIds.length} assigned ward(s)`;

  const modules=[];
  if(can('tickets:read')){
    modules.push({id:'queue',label:level==='APPELLATE_AUTHORITY'?'Appeals':'Case queue',icon:'inbox',route:'/queue'});
  }
  if(can('analytics:view')){
    modules.push({id:'analytics',label:'Analytics',icon:'chart',route:'/analytics'});
    modules.push({id:'activity',label:'Activity',icon:'history',route:'/activity'});
  }
  // Admin management needs the protected role itself, not merely the
  // permission label - the same rule the admin routes enforce.
  if(req.user.roleId==='ROLE-SUPER-ADMIN'){
    modules.push({id:'staff',label:'Staff & roles',icon:'people',route:'/staff'});
  }
  modules.push({id:'account',label:'Account',icon:'person',route:'/account'});

  res.json({
    portal:'department',
    apiVersion:MOBILE_API_VERSION,
    identity:{
      id:req.user.id,name:req.user.name,email:req.user.email,
      roleId:role.id,roleName:role.name,accessLevel:level,
      scopeType:role.scopeType,divisionId:role.divisionId??null,
      scopeLabel,
      mustChangePassword:Boolean(getUserById.get(req.user.id)?.must_change_password),
    },
    // What the app may OFFER. Every route still authorises independently.
    can:{
      readTickets:can('tickets:read'),
      resolve:can('tickets:resolve'),
      reroute:can('tickets:reroute'),
      viewAnalytics:can('analytics:view'),
      manageStaff:req.user.roleId==='ROLE-SUPER-ADMIN',
      // Only the triage desk may move an OTHER case, and it may not resolve.
      routeOtherCases:level==='OTHER_CASE_TRIAGE'&&can('tickets:reroute'),
    },
    modules,
    statuses:['PENDING','UNDER_INVESTIGATION','RESOLVED'],
  });
});

/*
 * Interface translation for the workspace.
 *
 * The same contract the citizen portal uses, and for the same reason: staff
 * at a district desk are not all comfortable reading an English interface,
 * and a grievance system that only its English-reading officers can operate
 * narrows who can be an officer.
 *
 * A batching cache in front of Azure Translator. The chrome is a closed set
 * of a few hundred strings, so the first officer to pick Odia pays for it and
 * everyone after is served from memory. Misses are cached as misses, so an
 * untranslatable string is not re-requested on every render.
 *
 * Case text is NOT translated through here. A complaint is evidence and is
 * shown as the citizen wrote it, with the English rendering the citizen
 * portal already produced beside it.
 */
const PORTAL_LANGUAGES=['en','hi','bn','ta','te','mr','gu','kn','ml','pa','or','as','ur','ne'];
const uiTranslationCache=new Map();
const UI_CACHE_MAX=20000;

const uiTranslateLimiter=rateLimit({windowMs:60*1000,limit:30,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Translation limit reached.'}});

app.get('/api/i18n/languages',(_req,res)=>res.json({
  languages:PORTAL_LANGUAGES,
  enabled:Boolean(process.env.AZURE_TRANSLATOR_KEY),
}));

app.post('/api/i18n',uiTranslateLimiter,async(req,res)=>{
  const to=String(req.body?.to??'').trim();
  if(!PORTAL_LANGUAGES.includes(to))return res.status(400).json({error:'Not a portal language.'});
  if(to==='en')return res.json({translations:{},language:'en'});
  const key=process.env.AZURE_TRANSLATOR_KEY??'';
  if(!key)return res.status(503).json({error:'Interface translation is not configured.'});

  const texts=Array.isArray(req.body?.texts)?req.body.texts:[];
  const wanted=[...new Set(texts.map(t=>String(t??'').trim()).filter(t=>t.length>0&&t.length<=400))].slice(0,600);

  const translations={};const missing=[];
  for(const text of wanted){
    const hit=uiTranslationCache.get(`${to}|${text}`);
    if(hit!==undefined){if(hit)translations[text]=hit;}else missing.push(text);
  }

  try{
    for(let i=0;i<missing.length;i+=90){
      const group=missing.slice(i,i+90);
      const url=new URL('/translate','https://api.cognitive.microsofttranslator.com');
      url.searchParams.set('api-version','3.0');url.searchParams.set('from','en');url.searchParams.set('to',to);url.searchParams.set('textType','plain');
      const headers={'Ocp-Apim-Subscription-Key':key,'Content-Type':'application/json'};
      if(process.env.AZURE_TRANSLATOR_REGION)headers['Ocp-Apim-Subscription-Region']=process.env.AZURE_TRANSLATOR_REGION;
      const r=await fetch(url,{method:'POST',headers,body:JSON.stringify(group.map(t=>({Text:t}))),signal:AbortSignal.timeout(20000)});
      if(!r.ok)return res.status(502).json({error:`Translator returned ${r.status}.`});
      const data=await r.json();
      group.forEach((text,n)=>{
        const value=data?.[n]?.translations?.[0]?.text??null;
        if(uiTranslationCache.size>=UI_CACHE_MAX){const oldest=uiTranslationCache.keys().next().value;if(oldest!==undefined)uiTranslationCache.delete(oldest);}
        uiTranslationCache.set(`${to}|${text}`,value);
        if(value)translations[text]=value;
      });
    }
  }catch(error){return res.status(502).json({error:`Translation failed: ${error.message}`});}

  res.json({language:to,translations,cached:wanted.length-missing.length,fetched:missing.length});
});

/*
 * Service-to-service endpoints for the citizen portal.
 *
 * The integration guide records that citizen tracking is not implemented and
 * invites a contract for it. These are that contract, and they are
 * deliberately the smallest thing that works:
 *
 *   /api/intake/wards        the ward list, so the citizen side can resolve a
 *                            PIN code to a ward id this API will accept
 *                            rather than guessing one
 *   /api/intake/status/:id   status and report for ONE case, by grievance id
 *
 * Both require a shared service key, not a staff session. The citizen portal
 * is a server, not a person; giving it a staff token would hand a public-
 * facing service the scope of whichever officer it borrowed. Neither endpoint
 * exposes any other case, and status returns no complainant identity - it is
 * for telling a citizen about their own complaint, which they already filed.
 *
 * When no key is configured both stay closed, so a misconfigured deployment
 * fails shut rather than open.
 */
function requireServiceKey(req,res,next){
  if(!(process.env.MHA_INTAKE_SERVICE_KEY??''))return res.status(503).json({error:'Service integration is not configured.'});
  if(!hasServiceKey(req))return res.status(401).json({error:'Not authorised.'});
  return next();
}

/*
 * An officer's reply to the citizen.
 *
 * Stored here on the ticket and collected by the citizen portal's sweep, so
 * the citizen reads one thread rather than having to look in two places for
 * half a conversation each.
 *
 * Scoped like any other mutation: an officer who cannot see the ticket
 * cannot comment on it, and out of scope returns 404 rather than 403 so the
 * queue does not become a way to discover which cases exist elsewhere.
 */
db.exec(`CREATE TABLE IF NOT EXISTS ticket_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL,
  grievance_id TEXT NOT NULL,
  user_id TEXT,
  author_name TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered INTEGER NOT NULL DEFAULT 0
)`);
db.exec('CREATE INDEX IF NOT EXISTS ticket_replies_pending ON ticket_replies(delivered, id)');

app.post('/api/tickets/:id/reply',requireAuth,requirePermission('tickets:read'),(req,res)=>{
  const current=ticketById.get(req.params.id);
  if(!current)return res.status(404).json({error:'Case not found.'});
  // Reuse the same visibility test the status update uses, so a reply can
  // never reach a case the officer could not have opened.
  const scope=ticketScope(req);
  const visible=db.prepare(`SELECT 1 FROM tickets${scope.sql?scope.sql+' AND':' WHERE'} id=?`).get(...scope.params,req.params.id);
  if(!visible)return res.status(404).json({error:'Case not found.'});

  const body=String(req.body?.body??'').trim();
  if(body.length<2)return res.status(422).json({error:'Write a reply first.'});
  if(body.length>2000)return res.status(422).json({error:'Keep the reply under 2000 characters.'});

  db.transaction(()=>{
    db.prepare('INSERT INTO ticket_replies(ticket_id,grievance_id,user_id,author_name,body) VALUES(?,?,?,?,?)')
      .run(current.id,current.grievance_id,req.user.id,req.user.name,body);
    // Writing to the complainant is a human acting on the case, so it
    // starts the clock the same way a status change does. Without this a
    // desk that answers every case within the hour but changes the status
    // later would score as if it had never responded.
    if(!current.first_action_at){
      db.prepare('UPDATE tickets SET first_action_at=? WHERE id=?').run(new Date().toISOString(),current.id);
    }
    audit(req.user.id,'TICKET_REPLY',`${req.user.name} replied on ${current.grievance_id}.`,current.id);
  })();

  res.status(201).json({ok:true});
});

app.get('/api/tickets/:id/replies',requireAuth,requirePermission('tickets:read'),(req,res)=>{
  const current=ticketById.get(req.params.id);
  if(!current)return res.status(404).json({error:'Case not found.'});
  const scope=ticketScope(req);
  const visible=db.prepare(`SELECT 1 FROM tickets${scope.sql?scope.sql+' AND':' WHERE'} id=?`).get(...scope.params,req.params.id);
  if(!visible)return res.status(404).json({error:'Case not found.'});
  res.json({replies:db.prepare('SELECT id,author_name,body,created_at FROM ticket_replies WHERE ticket_id=? ORDER BY id').all(current.id)});
});

/**
 * Replies the citizen portal has not collected yet.
 *
 * Pulled rather than pushed: the department does not know or care where the
 * citizen portal lives, and a pull means a portal that was down for an hour
 * catches up by itself instead of losing an officer's reply.
 */
app.get('/api/intake/replies',serviceReadLimiter,requireServiceKey,(_req,res)=>{
  res.json({replies:db.prepare('SELECT id,grievance_id,author_name,body,created_at FROM ticket_replies WHERE delivered=0 ORDER BY id LIMIT 200').all()});
});

app.post('/api/intake/replies/ack',serviceReadLimiter,requireServiceKey,(req,res)=>{
  const ids=Array.isArray(req.body?.ids)?req.body.ids.map(Number).filter(Number.isInteger).slice(0,200):[];
  if(ids.length===0)return res.json({acknowledged:0});
  const mark=db.prepare(`UPDATE ticket_replies SET delivered=1 WHERE id IN (${ids.map(()=>'?').join(',')})`);
  const r=db.transaction(()=>mark.run(...ids))();
  res.json({acknowledged:r.changes});
});

app.get('/api/intake/wards',serviceReadLimiter,requireServiceKey,(_req,res)=>{
  res.json({wards:wardsList.all().map(w=>({id:w.id,name:w.name,district:w.district,state:w.state,pincodePrefix:w.pincode_prefix,zone:w.zone}))});
});

app.get('/api/intake/status/:grievanceId',serviceReadLimiter,requireServiceKey,(req,res)=>{
  const row=db.prepare('SELECT grievance_id,division_id,category,status,sla_status,submission_timestamp,sla_deadline,action_taken_report,updated_at FROM tickets WHERE grievance_id=?').get(String(req.params.grievanceId));
  if(!row)return res.status(404).json({error:'No case with that grievance id.'});
  res.json({
    grievanceId:row.grievance_id,divisionId:row.division_id,category:row.category,
    status:row.status,slaStatus:row.sla_status,
    submittedAt:row.submission_timestamp,slaDeadline:row.sla_deadline,
    actionTakenReport:row.action_taken_report??null,updatedAt:row.updated_at,
  });
});

app.post('/api/intake/grievances',intakeLimiter,(req,res)=>{
  const body=req.body??{};const name=String(body.complainantName??'').trim();const mobile=String(body.mobileNumber??'').trim();const wardId=String(body.wardId??'');const category=String(body.category??'');const divisionId=String(body.divisionId??'');
  const validDivision=divisions.some(([id])=>id===divisionId);
  const matchingCategory=category==='OTHER'?divisionId==='OTHER_TRIAGE':validDivision&&categoryDivisions[category]===divisionId;
  if(name.length<2||name.length>120||mobile.length<7||mobile.length>25||!wardId||!category||!matchingCategory)return res.status(400).json({error:'A valid name, mobile, ward, category, and matching department are required.'});
  const ward=getWardById.get(wardId);if(!ward)return res.status(400).json({error:'Choose a valid service ward.'});
  const text=String(body.originalRegionalText??'').trim();const translation=String(body.translatedEnglishText??'').trim();if(!text||text.length>10000||translation.length>10000)return res.status(400).json({error:'Complaint text is required and must be under 10,000 characters.'});
  const details=body.details&&typeof body.details==='object'&&!Array.isArray(body.details)?body.details:{};const now=new Date();const submitted=now.toISOString();const deadline=new Date(now.getTime()+21*86400000).toISOString();const next=db.prepare("SELECT COALESCE(MAX(CAST(substr(grievance_id,10) AS INTEGER)),0)+1 AS n FROM tickets WHERE grievance_id LIKE ?").get(`MHA-${now.getUTCFullYear()}-%`).n;const grievanceId=`MHA-${now.getUTCFullYear()}-${String(next).padStart(4,'0')}`;const id=`TICKET-${randomUUID()}`;
  const location=body.location&&typeof body.location==='object'?body.location:{state:ward.state,district:ward.district,pincode:ward.pincode_prefix,completeAddress:`${ward.name}, ${ward.district}`,coordinates:{latitude:0,longitude:0}};
  const payload={complainantProfile:{otpVerified:Boolean(body.complainantProfile?.otpVerified),gender:['FEMALE','MALE','NON_BINARY','NOT_SPECIFIED'].includes(body.complainantProfile?.gender)?body.complainantProfile.gender:'NOT_SPECIFIED',...(typeof body.complainantProfile?.email==='string'?{email:body.complainantProfile.email.slice(0,254)}:{})},location,detectedLanguage:String(body.detectedLanguage??'Hindi').slice(0,40),declarationOfTruth:Boolean(body.declarationOfTruth),audioFileUrl:String(body.audioFileUrl??''),originalRegionalText:text,translatedEnglishText:translation,evidence:Array.isArray(body.evidence)?body.evidence.slice(0,10):[],details:category==='OTHER'?{}:details};
  db.prepare('INSERT INTO tickets(id,grievance_id,complainant_name,mobile_number,ward_id,division_id,category,status,sla_status,submission_timestamp,sla_deadline,payload_json) VALUES(?,?,?,?,?,?,?,\'PENDING\',\'ON_TIME\',?,?,?)').run(id,grievanceId,name,mobile,wardId,divisionId,category,submitted,deadline,JSON.stringify(payload));audit(null,'CITIZEN_INTAKE',`${grievanceId} received through the intake API.`,id,{divisionId,wardId});
  const ticket=toTicket(ticketById.get(id));res.status(201).json({ticket});
});
app.patch('/api/tickets/:id',requireAuth,(req,res)=>{
  const current=ticketById.get(req.params.id);if(!current||!canSeeTicket(req,current))return res.status(404).json({error:'Grievance not found in your scope.'});
  if(req.body?.routeToDivisionId){
    if(req.role.accessLevel!=='OTHER_CASE_TRIAGE'||!req.role.permissions.includes('tickets:reroute')||current.category!=='OTHER')return res.status(403).json({error:'Only a permitted Other Case Triage Officer can route cases from the Other department.'});
    const destination=divisions.find(([id])=>id===req.body.routeToDivisionId);
    if(!destination||destination[0]==='OTHER_TRIAGE')return res.status(400).json({error:'Choose a valid destination department.'});
    const payload=JSON.parse(current.payload_json);delete payload.details;
    db.transaction(()=>{db.prepare('UPDATE tickets SET division_id=?,category=?,payload_json=?,updated_at=? WHERE id=?').run(destination[0],destination[2],JSON.stringify(payload),new Date().toISOString(),current.id);audit(req.user.id,'OTHER_CASE_ROUTED',`${current.grievance_id} routed to ${destination[1]}.`,current.id,{divisionId:destination[0]});})();
    return res.json(ticketForRole(ticketById.get(current.id),req));
  }
  const status=req.body?.status;const report=typeof req.body?.actionTakenReport==='string'?req.body.actionTakenReport.trim():undefined;
  if(!['PENDING','UNDER_INVESTIGATION','RESOLVED'].includes(status))return res.status(400).json({error:'Choose a valid case status.'});
  if(status==='RESOLVED'&&!req.role.permissions.includes('tickets:resolve'))return res.status(403).json({error:'The tickets:resolve permission is required.'});
  if(status==='UNDER_INVESTIGATION'&&status!==current.status&&!req.role.permissions.includes('tickets:reroute')&&!req.role.permissions.includes('tickets:resolve'))return res.status(403).json({error:'The tickets:reroute permission is required.'});
  if(status==='PENDING'&&status!==current.status&&!req.role.permissions.includes('tickets:reroute'))return res.status(403).json({error:'The tickets:reroute permission is required.'});
  if(report!==undefined&&report.length>5000)return res.status(400).json({error:'Action report must be under 5,000 characters.'});
  if(report!==undefined&&!req.role.permissions.includes('tickets:resolve'))return res.status(403).json({error:'The tickets:resolve permission is required to add an official report.'});
  /*
   * Assignment, which is separate from status.
   *
   * A case belongs to a desk by division and ward; this names the officer
   * who owns it. Only somebody who can already act on the case may hand it
   * out, and only to an active account that could see it anyway - handing
   * a case to an officer whose role cannot open it is how work disappears.
   */
  let assignee;
  if (req.body?.assignedUserId !== undefined) {
    if (!req.role.permissions.includes('tickets:resolve') && !req.role.permissions.includes('tickets:reroute')) {
      return res.status(403).json({ error: 'You do not have permission to assign cases.' });
    }
    const wanted = req.body.assignedUserId;
    if (wanted === null || wanted === '') {
      assignee = null;
    } else {
      const candidate = getUserById.get(String(wanted));
      if (!candidate || !candidate.is_active) return res.status(400).json({ error: 'Choose an active member of staff.' });
      const candidateRole = toRole(getRoleById.get(candidate.role_id));
      if (!candidateRole) return res.status(400).json({ error: 'That account has no active role.' });
      if (candidateRole.id !== 'ROLE-SUPER-ADMIN'
        && candidateRole.divisionId
        && candidateRole.divisionId !== current.division_id) {
        return res.status(400).json({ error: 'That officer cannot open cases in this division.' });
      }
      assignee = candidate.id;
    }
  }

  const now=new Date().toISOString();
  // The first time a human touches the case, and the moment it closes.
  const firstAction = current.first_action_at ?? now;
  const resolvedAt = status === 'RESOLVED'
    ? (current.resolved_at ?? now)
    : null;

  db.transaction(()=>{
    db.prepare(`UPDATE tickets
                   SET status=?,
                       action_taken_report=COALESCE(?,action_taken_report),
                       assigned_user_id=COALESCE(?,assigned_user_id),
                       first_action_at=?,
                       resolved_at=?,
                       updated_at=?
                 WHERE id=?`)
      .run(status, report??null, assignee===undefined?null:assignee, firstAction, resolvedAt, now, current.id);

    // COALESCE cannot clear a column, so an explicit unassign is its own
    // statement rather than a special null that the merge would ignore.
    if (assignee === null) db.prepare('UPDATE tickets SET assigned_user_id=NULL WHERE id=?').run(current.id);

    audit(req.user.id,'TICKET_UPDATED',`${current.grievance_id} updated to ${status}.`,current.id,{status,hasReport:Boolean(report)});
    if (assignee !== undefined) {
      const name = assignee ? (getUserById.get(assignee)?.name ?? 'an officer') : null;
      audit(req.user.id, 'TICKET_ASSIGNED',
        name ? `${current.grievance_id} assigned to ${name}.` : `${current.grievance_id} unassigned.`,
        current.id, { assignedUserId: assignee });
    }
  })();
  res.json(ticketForRole(ticketById.get(current.id),req));
});

app.get('/api/roles',requireAuth,requireSuperAdmin,(_req,res)=>res.json(rolesList.all().map(toRole)));
app.post('/api/roles',requireAuth,requireSuperAdmin,(req,res)=>{
  const name=String(req.body?.name??'').trim();const description=String(req.body?.description??'').trim();const scopeType=req.body?.scopeType;const perms=req.body?.permissions;const divisionId=req.body?.divisionId??null;const wardIds=Array.isArray(req.body?.wardIds)?req.body.wardIds:[];
  const accessLevel=['DIVISION_ADMIN','L1_RESOLVING_OFFICER','APPELLATE_AUTHORITY','OTHER_CASE_TRIAGE'].includes(req.body?.accessLevel)?req.body.accessLevel:(scopeType==='WARD'?'L1_RESOLVING_OFFICER':'DIVISION_ADMIN');
  if(accessLevel==='OTHER_CASE_TRIAGE'&&(scopeType!=='DIVISION'||divisionId!=='OTHER_TRIAGE'))return res.status(400).json({error:'Other Case Triage roles must belong to the Other Cases Triage department.'});
  if(name.length<2||name.length>80||!['DIVISION','WARD'].includes(scopeType)||!Array.isArray(perms)||perms.some(p=>!permissions.includes(p)))return res.status(400).json({error:'Custom roles must use a valid division or ward scope and permission list.'});
  if((['DIVISION_ADMIN','APPELLATE_AUTHORITY','OTHER_CASE_TRIAGE'].includes(accessLevel)&&scopeType!=='DIVISION')||(accessLevel==='L1_RESOLVING_OFFICER'&&scopeType!=='WARD'))return res.status(400).json({error:'Choose a scope that matches the selected access level.'});
  if(perms.some(permission=>!accessLevelPermissionGrants[accessLevel].includes(permission)))return res.status(400).json({error:'This role access level cannot be granted one or more selected permission modules.'});
  if((scopeType==='DIVISION'||divisionId)&&!divisions.some(([id])=>id===divisionId))return res.status(400).json({error:'Choose a valid MHA division.'});
  if(divisionId==='OTHER_TRIAGE'&&accessLevel!=='OTHER_CASE_TRIAGE')return res.status(400).json({error:'The Other Cases Triage department can only use its triage access level.'});
  if(scopeType==='WARD'&&(!wardIds.length||wardIds.some(id=>!getWardById.get(id))))return res.status(400).json({error:'Choose at least one valid ward for this role.'});
  const id=`ROLE-CUSTOM-${randomUUID()}`;try{db.prepare('INSERT INTO roles(id,name,description,permissions_json,scope_type,division_id,ward_ids_json,is_system,access_level) VALUES(?,?,?,?,?,?,?,0,?)').run(id,name,description,JSON.stringify(perms),scopeType,divisionId||null,JSON.stringify(scopeType==='WARD'?wardIds:[]),accessLevel);audit(req.user.id,'ROLE_CREATED',`${name} role created.`,null,{scopeType,accessLevel});res.status(201).json(toRole(getRoleById.get(id)));}catch(error){if(error.code==='SQLITE_CONSTRAINT_UNIQUE')return res.status(409).json({error:'A role with that name already exists.'});throw error;}
});
app.patch('/api/roles/:id',requireAuth,requireSuperAdmin,(req,res)=>{
  const current=getRoleById.get(req.params.id);if(!current)return res.status(404).json({error:'Role not found.'});
  const name=String(req.body?.name??'').trim();const description=String(req.body?.description??'').trim();const perms=req.body?.permissions;
  if(name.length<2||name.length>80||!Array.isArray(perms)||perms.some(permission=>!permissions.includes(permission)))return res.status(400).json({error:'Enter a valid role name and permission list.'});
  const accessLevel=['SUPER_ADMIN','DIVISION_ADMIN','L1_RESOLVING_OFFICER','APPELLATE_AUTHORITY','OTHER_CASE_TRIAGE'].includes(req.body?.accessLevel)?req.body.accessLevel:current.access_level;
  if(accessLevel==='SUPER_ADMIN'&&current.id!=='ROLE-SUPER-ADMIN')return res.status(400).json({error:'Only the protected Staff Admin role can have Super Admin access.'});
  if(accessLevel==='OTHER_CASE_TRIAGE'&&current.division_id!=='OTHER_TRIAGE')return res.status(400).json({error:'Other Case Triage access is limited to the Other Cases Triage department.'});
  if(current.division_id==='OTHER_TRIAGE'&&accessLevel!=='OTHER_CASE_TRIAGE')return res.status(400).json({error:'The Other Cases Triage department can only use its triage access level.'});
  if((['DIVISION_ADMIN','APPELLATE_AUTHORITY','OTHER_CASE_TRIAGE'].includes(accessLevel)&&current.scope_type!=='DIVISION')||(accessLevel==='L1_RESOLVING_OFFICER'&&current.scope_type!=='WARD'))return res.status(400).json({error:'The role scope does not match the selected access level.'});
  if(perms.some(permission=>!accessLevelPermissionGrants[accessLevel].includes(permission)))return res.status(400).json({error:'This role access level cannot be granted one or more selected permission modules.'});
  try{db.prepare('UPDATE roles SET name=?,description=?,permissions_json=?,access_level=? WHERE id=?').run(name,description,JSON.stringify([...new Set(perms)]),accessLevel,current.id);audit(req.user.id,'ROLE_UPDATED',`${name} permissions updated.`,null,{roleId:current.id,accessLevel});res.json(toRole(getRoleById.get(current.id)));}catch(error){if(error.code==='SQLITE_CONSTRAINT_UNIQUE')return res.status(409).json({error:'A role with that name already exists.'});throw error;}
});

app.get('/api/users',requireAuth,requireSuperAdmin,(_req,res)=>res.json(userDirectoryList.all().map(publicAccount)));
app.post('/api/users',requireAuth,requireSuperAdmin,(req,res)=>{
  const name=String(req.body?.name??'').trim();const email=String(req.body?.email??'').trim().toLowerCase();const mobile=String(req.body?.mobileNumber??'').trim();const role=getRoleById.get(String(req.body?.roleId??''));const assigned=Array.isArray(req.body?.assignedWards)?req.body.assignedWards:[];
  if(name.length<2||name.length>100||!/^\S+@\S+\.\S+$/.test(email)||email.length>254||mobile.length<7||mobile.length>30||!role||role.id==='ROLE-SUPER-ADMIN')return res.status(400).json({error:'Enter valid user details and choose a staff role.'});
  if(role.id==='ROLE-SUPER-ADMIN')return res.status(400).json({error:'Staff accounts cannot be assigned the protected Staff Admin role.'});
  const roleObj=toRole(role);if(roleObj.scopeType==='WARD'&&(!assigned.length||assigned.some(id=>!getWardById.get(id)||(roleObj.wardIds?.length&&!roleObj.wardIds.includes(id)))))return res.status(400).json({error:'Select at least one ward allowed by the assigned role.'});
  const id=`USER-${randomUUID()}`;const initials=name.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase();const password=randomBytes(12).toString('base64url');const hashPassword=bcrypt.hashSync(password,12);
  try{db.prepare('INSERT INTO users(id,name,email,mobile_number,password_hash,role_id,assigned_wards_json,is_active,avatar_initials,must_change_password) VALUES(?,?,?,?,?,?,?,?,?,1)').run(id,name,email,mobile,hashPassword,roleObj.id,JSON.stringify(roleObj.scopeType==='WARD'?assigned:[]),1,initials);audit(req.user.id,'USER_CREATED',`${name} account created.`,null,{roleId:roleObj.id});res.status(201).json({...publicAccount(getUserById.get(id)),temporaryPassword:password});}catch(error){if(error.code==='SQLITE_CONSTRAINT_UNIQUE')return res.status(409).json({error:'An account with that email already exists.'});throw error;}
});
app.patch('/api/users/:id',requireAuth,requireSuperAdmin,(req,res)=>{
  const target=getUserById.get(req.params.id);if(!target)return res.status(404).json({error:'Account not found.'});
  if(target.id===req.user.id&&req.body?.isActive===false)return res.status(400).json({error:'Sign out before deactivating your own account.'});
  const active=req.body?.isActive;const name=String(req.body?.name??target.name).trim();const email=String(req.body?.email??target.email).trim().toLowerCase();const roleId=String(req.body?.roleId??target.role_id);const role=getRoleById.get(roleId);const assigned=Array.isArray(req.body?.assignedWards)?req.body.assignedWards:JSON.parse(target.assigned_wards_json);
  if(typeof active!=='boolean'&&req.body?.name===undefined&&req.body?.email===undefined&&req.body?.roleId===undefined)return res.status(400).json({error:'Provide account fields to update.'});
  if(name.length<2||name.length>100||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!role)return res.status(400).json({error:'Enter valid account details and choose a role.'});
  if(role.id==='ROLE-SUPER-ADMIN'&&target.role_id!=='ROLE-SUPER-ADMIN')return res.status(400).json({error:'Staff accounts cannot be assigned the protected Staff Admin role.'});
  if(target.role_id==='ROLE-SUPER-ADMIN'&&roleId!=='ROLE-SUPER-ADMIN')return res.status(400).json({error:'The Super Admin account is protected.'});
  const roleObj=toRole(role);if(roleObj.scopeType==='WARD'&&(!assigned.length||assigned.some(id=>!getWardById.get(id)||(roleObj.wardIds?.length&&!roleObj.wardIds.includes(id)))))return res.status(400).json({error:'Select at least one ward allowed by the assigned role.'});
  const savedAssigned=roleObj.scopeType==='WARD'?assigned:[];
  const isActive=typeof active==='boolean'?active:Boolean(target.is_active);
  try{db.transaction(()=>{db.prepare('UPDATE users SET name=?,email=?,role_id=?,assigned_wards_json=?,is_active=? WHERE id=?').run(name,email,roleId,JSON.stringify(savedAssigned),isActive?1:0,target.id);if(!isActive)db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);audit(req.user.id,'USER_UPDATED',`${name} account updated.`,null,{roleId,isActive});})();}catch(error){if(error.code==='SQLITE_CONSTRAINT_UNIQUE')return res.status(409).json({error:'An account with that email already exists.'});throw error;}
  res.json(publicAccount(getUserById.get(target.id)));
});
app.post('/api/users/:id/reset-password',requireAuth,requireSuperAdmin,(req,res)=>{
  const target=getUserById.get(req.params.id);if(!target)return res.status(404).json({error:'Account not found.'});const password=randomBytes(12).toString('base64url');const passwordHash=bcrypt.hashSync(password,12);
  db.transaction(()=>{db.prepare('UPDATE users SET password_hash=?,must_change_password=1,password_reset_at=? WHERE id=?').run(passwordHash,new Date().toISOString(),target.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);audit(req.user.id,'PASSWORD_RESET',`${target.name} password reset.`);})();res.json({ok:true,temporaryPassword:password});
});
// Local prototype recovery for the sole Super Admin when all admin sessions are lost.
app.post('/api/auth/recover-super-admin',rateLimit({windowMs:60*60*1000,limit:5,standardHeaders:'draft-8',legacyHeaders:false}), (req,res)=>{
  if(process.env.NODE_ENV==='production')return res.status(404).json({error:'Recovery endpoint not available.'});
  const email=String(req.body?.email??'').trim().toLowerCase();const row=userByEmail.get(email);if(!row||row.role_id!=='ROLE-SUPER-ADMIN')return res.status(404).json({error:'Super Admin account not found.'});
  const password=randomBytes(12).toString('base64url');db.transaction(()=>{db.prepare('UPDATE users SET password_hash=?,must_change_password=1,password_reset_at=? WHERE id=?').run(bcrypt.hashSync(password,12),new Date().toISOString(),row.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.id);audit(row.id,'SUPER_ADMIN_RECOVERY','Super Admin recovery password generated.');})();res.json({email:row.email,temporaryPassword:password});
});

app.get('/api/analytics/summary',requireAuth,requirePermission('analytics:view'),(req,res)=>{
  const scope=ticketScope(req);const rows=db.prepare(`SELECT status,sla_status,COUNT(*) AS count FROM tickets${scope.sql} GROUP BY status,sla_status`).all(...scope.params);
  const byStatus={PENDING:0,UNDER_INVESTIGATION:0,RESOLVED:0};const bySla={ON_TIME:0,WARNING:0,OVERDUE:0};for(const r of rows){byStatus[r.status]+=r.count;bySla[r.sla_status]+=r.count;}

  /*
   * How long cases actually take, in this officer's own scope.
   *
   * Two separate figures, because they answer different complaints. Time to
   * first action is how long somebody waited before any human looked;
   * time to resolution is how long the whole thing took. A desk can be fast
   * at the first and slow at the second, and averaging them together would
   * hide exactly that.
   *
   * Averaged only over the cases that reached each milestone, with the
   * sample size returned beside it. An average over three cases is not the
   * same claim as one over three hundred, and the UI says which it is.
   */
  const timing=db.prepare(`SELECT
      COUNT(first_action_at) AS acted,
      COUNT(resolved_at)     AS closed,
      AVG(CASE WHEN first_action_at IS NOT NULL
               THEN (julianday(first_action_at) - julianday(submission_timestamp)) * 24 END) AS first_hours,
      AVG(CASE WHEN resolved_at IS NOT NULL
               THEN (julianday(resolved_at) - julianday(submission_timestamp)) * 24 END) AS resolve_hours
    FROM tickets${scope.sql}`).get(...scope.params);

  const round1=(value)=>value===null||value===undefined?null:Math.round(value*10)/10;

  const assigned=db.prepare(`SELECT COUNT(*) AS n FROM tickets${scope.sql?scope.sql+' AND':' WHERE'} assigned_user_id IS NOT NULL`).get(...scope.params);

  res.json({
    total:Object.values(byStatus).reduce((a,b)=>a+b,0),
    byStatus,
    bySla,
    responseTime:{
      // Negative is impossible but a clock skew between two machines could
      // produce it; clamped so the dashboard never shows "-3 hours".
      averageFirstActionHours:round1(Math.max(0,timing.first_hours??0))||null,
      averageResolutionHours:round1(Math.max(0,timing.resolve_hours??0))||null,
      actedOn:timing.acted,
      closed:timing.closed,
    },
    assignment:{
      assigned:assigned.n,
      unassigned:Object.values(byStatus).reduce((a,b)=>a+b,0)-assigned.n,
    },
    generatedAt:new Date().toISOString(),
  });
});
app.get('/api/activity',requireAuth,requirePermission('analytics:view'),(req,res)=>res.json(scopedActivities(req)));

app.use('/api',(req,res)=>res.status(404).json({error:'API endpoint not found.'}));

/*
 * Serve the built workspace when one exists.
 *
 * In development Vite serves the UI on 5173 and proxies /api here, so this
 * does nothing. In a container there is no Vite, so the API also hands out
 * dist/ and lets the client router handle unknown paths. Declared AFTER the
 * /api 404 so it can never shadow an API route.
 */
const distDir=resolve(process.cwd(),'dist');
if(existsSync(distDir)){
  app.use(express.static(distDir,{maxAge:'1h',setHeaders:(res,filePath)=>{if(filePath.endsWith('.html'))res.setHeader('Cache-Control','no-cache');}}));
  app.get(/^(?!\/api\/).*/,(_req,res)=>res.sendFile(join(distDir,'index.html')));
}

app.use((error,_req,res,_next)=>{console.error(error);res.status(500).json({error:'The request could not be completed.'});});

app.listen(port,host,()=>console.log(`MHA API listening on http://${host}:${port} (SQLite: ${process.env.MHA_DATABASE_PATH??'data/mha-grievance.sqlite'})`));

