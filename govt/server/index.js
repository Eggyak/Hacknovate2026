import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  db, divisions, permissions, accessLevelPermissionGrants, seedDatabase, toRole, toUser, toTicket,
  getUserById, getRoleById, publicUserQuery, userByEmail, rolesList, wardsList,
  usersList, userDirectoryList, eventsList, ticketById, getWardById,
} from './db.js';

seedDatabase();
const app=express();
const port=Number(process.env.API_PORT??3001);
// Loopback is right for the local prototype and wrong inside a container,
// where nothing outside the namespace could then reach it. Default is
// unchanged so START_MHA_DASHBOARD.bat behaves exactly as before.
const host=process.env.API_HOST??'127.0.0.1';
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
app.post('/api/auth/login',(req,res)=>{
  const email=String(req.body?.email??'').trim().toLowerCase();const password=String(req.body?.password??'');
  if(email.length>254||password.length>200||!email||!password)return res.status(400).json({error:'Enter your department email and password.'});
  const row=userByEmail.get(email);const dummy='$2b$10$3TtZ0N45oW2GLTtStTa/xOYKYmNdFK31yRqt6A3eAuR6wsHBmXOIG';
  const valid=bcrypt.compareSync(password,row?.password_hash??dummy);
  if(!row||!row.is_active||!valid)return res.status(401).json({error:'Email or password is incorrect, or the account is inactive.'});
  const role=toRole(getRoleById.get(row.role_id));if(!role)return res.status(403).json({error:'No active role is assigned to this account.'});
  const token=randomBytes(32).toString('base64url');const expires=Date.now()+sessionLifetime;const now=new Date().toISOString();
  db.transaction(()=>{db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hash(token),row.id,expires,Date.now());db.prepare('UPDATE users SET last_sign_in=? WHERE id=?').run(now,row.id);audit(row.id,'SIGN_IN',`${row.name} signed in.`);})();
  const user=toUser(getUserById.get(row.id));res.json({user,role,mustChangePassword:Boolean(row.must_change_password),token});
});
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
const intakeLimiter=rateLimit({windowMs:60*60*1000,limit:20,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Intake limit reached. Please try again later.'}});
const categoryDivisions=Object.fromEntries(divisions.map(([divisionId,,category])=>[category,divisionId]));
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
  const expected=process.env.MHA_INTAKE_SERVICE_KEY??'';
  if(!expected)return res.status(503).json({error:'Service integration is not configured.'});
  const given=String(req.get('x-service-key')??'');
  const a=createHash('sha256').update(given).digest();
  const b=createHash('sha256').update(expected).digest();
  if(!timingSafeEqual(a,b))return res.status(401).json({error:'Not authorised.'});
  return next();
}

app.get('/api/intake/wards',intakeLimiter,requireServiceKey,(_req,res)=>{
  res.json({wards:wardsList.all().map(w=>({id:w.id,name:w.name,district:w.district,state:w.state,pincodePrefix:w.pincode_prefix,zone:w.zone}))});
});

app.get('/api/intake/status/:grievanceId',intakeLimiter,requireServiceKey,(req,res)=>{
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
  const now=new Date().toISOString();
  db.transaction(()=>{db.prepare('UPDATE tickets SET status=?,action_taken_report=COALESCE(?,action_taken_report),updated_at=? WHERE id=?').run(status,report??null,now,current.id);audit(req.user.id,'TICKET_UPDATED',`${current.grievance_id} updated to ${status}.`,current.id,{status,hasReport:Boolean(report)});})();
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
  res.json({total:Object.values(byStatus).reduce((a,b)=>a+b,0),byStatus,bySla,generatedAt:new Date().toISOString()});
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

