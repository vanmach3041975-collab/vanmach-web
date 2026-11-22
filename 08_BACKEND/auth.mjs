import crypto from 'node:crypto';
import fs from 'node:fs';
import {promisify} from 'node:util';
import {createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8} from 'jose';
import {mailDelivery} from './mail_delivery.mjs';
import {firebaseVerifier} from './firebase_identity.mjs';

const scrypt=promisify(crypto.scrypt);
const random=()=>crypto.randomBytes(32).toString('base64url');
const hash=value=>crypto.createHash('sha256').update(value).digest('base64url');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const emailOf=value=>typeof value==='string'?value.trim().toLowerCase():'';
const validEmail=value=>value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const passwordOf=value=>{if(typeof value!=='string'||value.length<10||value.length>128)fail(400,'Mật khẩu cần từ 10 đến 128 ký tự.');return value;};
const nameOf=value=>{const name=typeof value==='string'?value.trim():'';if(name.length<2||name.length>40)fail(400,'Tên hiển thị cần từ 2 đến 40 ký tự.');return name;};
const cost={N:32768,r:8,p:1,maxmem:64*1024*1024};
async function passwordHash(password,salt=crypto.randomBytes(16).toString('hex')) {
 const key=await scrypt(password,salt,32,cost);return salt+':'+key.toString('hex');
}
async function matches(password,stored) {
 const [salt,key]=stored.split(':');const candidate=await scrypt(password,salt,32,cost);
 return crypto.timingSafeEqual(candidate,Buffer.from(key,'hex'));
}
export function authEnvironment(env=process.env) {
 return {firebaseProjectId:env.FIREBASE_PROJECT_ID??'',publicUrl:env.APP_PUBLIC_URL||env.RENDER_EXTERNAL_URL||'http://127.0.0.1:8787',
 googleId:env.GOOGLE_CLIENT_ID??'',googleSecret:env.GOOGLE_CLIENT_SECRET??'',
 appleId:env.APPLE_CLIENT_ID??'',appleTeam:env.APPLE_TEAM_ID??'',appleKeyId:env.APPLE_KEY_ID??'',appleKeyFile:env.APPLE_PRIVATE_KEY_FILE??'',
 resendApiKey:env.RESEND_API_KEY??'',smtpHost:env.SMTP_HOST??'',smtpPort:Number(env.SMTP_PORT??587),smtpUser:env.SMTP_USER??'',smtpPassword:env.SMTP_PASSWORD??'',mailFrom:env.MAIL_FROM??''};
}
export class AuthService {
 constructor(db,{config=authEnvironment(),fetchImpl=fetch,verifyIdentity=null,verifyFirebase=null,sendMail=null,now=Date.now}={}) {
  this.verifyFirebase=verifyFirebase??firebaseVerifier(config.firebaseProjectId);
  this.db=db;this.config=config;this.fetch=fetchImpl;this.verifyIdentity=verifyIdentity;this.now=now;
  this.base=new URL(config.publicUrl).origin;
  if(!this.base.startsWith('https://')&&!['localhost','127.0.0.1','[::1]'].includes(new URL(this.base).hostname))throw Error('APP_PUBLIC_URL requires HTTPS outside localhost');
  this.mail=sendMail??mailDelivery(config,fetchImpl);
  this.dummy=passwordHash('unusable-dummy-password-'+random());
  this.keys={google:createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),apple:createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'))};
  db.exec(`CREATE TABLE IF NOT EXISTS auth_users(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,password TEXT,provider TEXT NOT NULL,subject TEXT,verified INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS auth_email_unique ON auth_users(email) WHERE provider='email';
   CREATE UNIQUE INDEX IF NOT EXISTS auth_provider_subject ON auth_users(provider,subject) WHERE subject IS NOT NULL;
   CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS auth_flows(state_hash TEXT PRIMARY KEY,data TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS auth_tickets(ticket_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,challenge TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS auth_codes(email TEXT NOT NULL,purpose TEXT NOT NULL,code_hash TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(email,purpose));
   CREATE TABLE IF NOT EXISTS auth_rate_limits(bucket TEXT PRIMARY KEY,n INTEGER NOT NULL,expires INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS auth_rate_expiry ON auth_rate_limits(expires);`);
 }
 limit(key,max=10,window=900000) {
  const now=this.now();
  this.db.prepare('DELETE FROM auth_rate_limits WHERE expires<=?').run(now);
  // Hash bucket identifiers so this table does not duplicate emails/IPs.
  // SQLite updates survive restart and are shared by services using the same DB.
  const r=this.db.prepare(`INSERT INTO auth_rate_limits VALUES(?,1,?)
   ON CONFLICT(bucket) DO UPDATE SET n=min(auth_rate_limits.n+1,?)
   RETURNING n,expires`).get(hash(key),now+window,max+1);
  if(r.n>max)fail(429,`Bạn đã thử nhiều lần. Vui lòng chờ ${Math.max(1,Math.ceil((r.expires-now)/1000))} giây rồi thử lại.`);
 }
 capabilities(){const c=this.config;return {firebase:!!c.firebaseProjectId,emailLink:!!c.firebaseProjectId,emailOtp:!!this.mail,email:true,google:!!(c.googleId&&c.googleSecret),apple:!!(c.appleId&&c.appleTeam&&c.appleKeyId&&c.appleKeyFile&&this.base.startsWith('https://')),emailRecovery:!!this.mail};}
 async requestLoginOtp(body,ip){
  if(!this.mail)fail(503,'Chưa cấu hình dịch vụ gửi OTP email. Bạn vẫn có thể đăng nhập bằng mật khẩu hoặc Google.');
  const email=emailOf(body.email);if(!validEmail(email))fail(400,'Email chưa hợp lệ.');
  this.limit('otp-ip:'+ip,10);this.limit('otp-send:'+email,3);this.limit('otp-cooldown:'+email,1,60000);
  const code=String(crypto.randomInt(100000,1000000)),digest=await passwordHash(code);
  this.db.prepare('INSERT OR REPLACE INTO auth_codes VALUES(?,?,?,?,0)').run(email,'login',digest,this.now()+300000);
  try{await this.mail({to:email,subject:'Mã đăng nhập VănMạch',text:'Mã đăng nhập VănMạch: '+code+'\nMã có hiệu lực 5 phút, chỉ dùng một lần. Không chia sẻ mã này.'});}
  catch{this.db.prepare("DELETE FROM auth_codes WHERE email=? AND purpose='login' AND code_hash=?").run(email,digest);fail(503,'Chưa gửi được OTP. Vui lòng thử lại sau.');}
  return {ok:true,message:'Đã gửi mã. Kiểm tra hộp thư và thư rác.',expiresIn:300,resendAfter:60};
 }
 async verifyLoginOtp(body,ip){
  this.limit('otp-verify:'+ip,20);const email=emailOf(body.email);
  if(!validEmail(email)||typeof body.code!=='string'||!/^\d{6}$/.test(body.code))fail(400,'Nhập email và mã OTP gồm 6 chữ số.');
  const row=this.db.prepare("SELECT * FROM auth_codes WHERE email=? AND purpose='login'").get(email);
  if(!row||row.expires<=this.now()||row.attempts>=5)fail(400,'Mã không hợp lệ hoặc đã hết hạn.');
  this.db.prepare("UPDATE auth_codes SET attempts=attempts+1 WHERE email=? AND purpose='login'").run(email);
  if(!await matches(body.code,row.code_hash))fail(400,'Mã không hợp lệ hoặc đã hết hạn.');
  const consumed=this.db.prepare("DELETE FROM auth_codes WHERE email=? AND purpose='login' AND code_hash=? AND expires>? AND attempts<=5").run(email,row.code_hash,this.now());
  if(!consumed.changes)fail(400,'Mã đã dùng hoặc hết hiệu lực. Hãy yêu cầu mã mới.');
  // Keep passwordless identity separate from password/Firebase accounts.
  let u=this.db.prepare("SELECT * FROM auth_users WHERE provider='email_otp' AND subject=?").get(email);
  if(!u){u={id:random(),email,name:'',password:null,provider:'email_otp',subject:email,verified:1,complete:0,created:this.now()};this.db.prepare('INSERT INTO auth_users VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(u));}
  return this.session(u);
 }
 publicUser(u){return {id:u.id,email:u.email,name:u.name,provider:u.provider,emailVerified:!!u.verified,profileComplete:!!u.complete};}
 session(u){const token=random(),expires=this.now()+30*86400000;this.db.prepare('INSERT INTO auth_sessions VALUES(?,?,?)').run(hash(token),u.id,expires);this.db.prepare('DELETE FROM auth_sessions WHERE expires<?').run(this.now());return {token,expires,user:this.publicUser(u)};}
 user(token){if(typeof token!=='string'||token.length>200)fail(401,'Phiên đăng nhập đã hết hạn.');const u=this.db.prepare('SELECT u.* FROM auth_users u JOIN auth_sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires>?').get(hash(token),this.now());if(!u)fail(401,'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');return u;}
 async register(body,ip){this.limit('register:'+ip,8);const email=emailOf(body.email);if(!validEmail(email))fail(400,'Địa chỉ email chưa hợp lệ.');const name=nameOf(body.name),password=await passwordHash(passwordOf(body.password));
  if(this.db.prepare("SELECT id FROM auth_users WHERE email=? AND provider='email'").get(email))fail(409,'Không thể tạo tài khoản bằng email này. Hãy thử đăng nhập hoặc khôi phục mật khẩu.');
  const u={id:random(),email,name,password,provider:'email',subject:null,verified:0,complete:1,created:this.now()};this.db.prepare('INSERT INTO auth_users VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(u));return this.session(u);
 }
 async login(body,ip){this.limit('login-ip:'+ip,40);const email=emailOf(body.email);this.limit('login-email:'+hash(email),12);const password=typeof body.password==='string'&&body.password.length<=128?body.password:'';const u=this.db.prepare("SELECT * FROM auth_users WHERE email=? AND provider='email'").get(email);const okay=await matches(password,u?.password??await this.dummy);if(!u||!okay)fail(401,'Email hoặc mật khẩu chưa đúng.');return this.session(u);}
 logout(token){this.db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hash(token));return {ok:true};}
 profile(token,body){const u=this.user(token);const name=nameOf(body.name);this.db.prepare('UPDATE auth_users SET name=?,complete=1 WHERE id=?').run(name,u.id);return {user:this.publicUser({...u,name,complete:1})};}
 async changePassword(token,body){const u=this.user(token);if(u.provider!=='email')fail(400,'Tài khoản này đăng nhập qua '+u.provider+'. Đổi mật khẩu tại dịch vụ đó.');this.limit('change:'+u.id,6);if(typeof body.currentPassword!=='string'||body.currentPassword.length>128||!await matches(body.currentPassword,u.password))fail(400,'Mật khẩu hiện tại chưa đúng.');const next=await passwordHash(passwordOf(body.password));this.db.prepare('UPDATE auth_users SET password=? WHERE id=?').run(next,u.id);this.db.prepare('DELETE FROM auth_sessions WHERE user_id=? AND token_hash<>?').run(u.id,hash(token));return {ok:true};}
 async requestCode(body,ip,token){if(!this.mail)fail(503,'Máy chủ chưa cấu hình gửi email. Liên hệ người quản trị để bật khôi phục tài khoản.');this.limit('mail-ip:'+ip,12);const purpose=body.purpose==='verify'?'verify':'reset';const email=purpose==='verify'?this.user(token).email:emailOf(body.email);if(!validEmail(email))fail(400,'Email chưa hợp lệ.');this.limit('mail:'+email+purpose,3);const u=this.db.prepare("SELECT * FROM auth_users WHERE email=? AND provider='email'").get(email);
  if(u){const code=String(crypto.randomInt(10000000,100000000)),codeHash=hash(code);this.db.prepare('INSERT OR REPLACE INTO auth_codes VALUES(?,?,?,?,0)').run(email,purpose,codeHash,this.now()+600000);try{await this.mail({to:email,subject:purpose==='reset'?'Đặt lại mật khẩu VănMạch':'Xác minh email VănMạch',text:'Mã xác nhận VănMạch của bạn: '+code+'\nMã có hiệu lực trong 10 phút. Nếu không yêu cầu thao tác này, bạn có thể bỏ qua email.'});}catch{this.db.prepare('DELETE FROM auth_codes WHERE email=? AND purpose=? AND code_hash=?').run(email,purpose,codeHash);fail(503,'Chưa gửi được email. Vui lòng thử lại sau.');}}
  return {ok:true,message:'Nếu email phù hợp với tài khoản, mã xác nhận sẽ được gửi. Kiểm tra cả mục thư rác.'};
 }
 async confirmCode(body,ip,token){this.limit('code:'+ip,30);const purpose=body.purpose==='verify'?'verify':'reset';const email=purpose==='verify'?this.user(token).email:emailOf(body.email);const row=this.db.prepare('SELECT * FROM auth_codes WHERE email=? AND purpose=?').get(email,purpose);if(!row||row.expires<this.now()||row.attempts>=6)fail(400,'Mã không hợp lệ hoặc đã hết hạn.');this.db.prepare('UPDATE auth_codes SET attempts=attempts+1 WHERE email=? AND purpose=?').run(email,purpose);if(typeof body.code!=='string'||!crypto.timingSafeEqual(Buffer.from(hash(body.code)),Buffer.from(row.code_hash)))fail(400,'Mã không hợp lệ hoặc đã hết hạn.');
  const next=purpose==='reset'?await passwordHash(passwordOf(body.password)):null;
  // A code is consumed atomically after any asynchronous password work.
  const consumed=this.db.prepare('DELETE FROM auth_codes WHERE email=? AND purpose=? AND code_hash=? AND expires>?').run(email,purpose,row.code_hash,this.now());if(!consumed.changes)fail(400,'Mã đã được sử dụng.');
  if(purpose==='reset'){this.db.prepare("UPDATE auth_users SET password=?,verified=1 WHERE email=? AND provider='email'").run(next,email);this.db.prepare("DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM auth_users WHERE email=? AND provider='email')").run(email);}else this.db.prepare("UPDATE auth_users SET verified=1 WHERE email=? AND provider='email'").run(email);return {ok:true};
 }
 startOAuth(body,ip){this.limit('oauth:'+ip,20);const provider=body.provider;if(!['google','apple'].includes(provider)||!this.capabilities()[provider])fail(503,'Đăng nhập '+(provider==='apple'?'Apple':'Google')+' chưa được cấu hình trên máy chủ.');if(typeof body.challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.challenge))fail(400,'Yêu cầu xác thực chưa hợp lệ.');const state=random(),nonce=random(),verifier=random();const target=body.platform==='web'?'web':'native';
  const data={provider,nonce,verifier,target,challenge:body.challenge};this.db.prepare('INSERT INTO auth_flows VALUES(?,?,?)').run(hash(state),JSON.stringify(data),this.now()+600000);this.db.prepare('DELETE FROM auth_flows WHERE expires<?').run(this.now());
  const p=new URLSearchParams({client_id:provider==='google'?this.config.googleId:this.config.appleId,redirect_uri:this.base+'/api/auth/callback/'+provider,response_type:'code',scope:provider==='google'?'openid email profile':'name email',state,nonce});
  if(provider==='google'){p.set('code_challenge',hash(verifier));p.set('code_challenge_method','S256');p.set('prompt','select_account');}else p.set('response_mode','form_post');
  return {url:(provider==='google'?'https://accounts.google.com/o/oauth2/v2/auth?':'https://appleid.apple.com/auth/authorize?')+p.toString()};
 }
 async appleSecret(){const c=this.config;const key=await importPKCS8(fs.readFileSync(c.appleKeyFile,'utf8'),'ES256');return new SignJWT({}).setProtectedHeader({alg:'ES256',kid:c.appleKeyId}).setIssuer(c.appleTeam).setSubject(c.appleId).setAudience('https://appleid.apple.com').setIssuedAt().setExpirationTime('5m').sign(key);}
 callbackLocation(flow,params){const dest=flow.target==='web'?this.base+'/auth.html':'vanmach://auth';return dest+'#'+new URLSearchParams(params);}
 async callback(provider,body){const state=typeof body.state==='string'?body.state:'';const row=this.db.prepare('SELECT * FROM auth_flows WHERE state_hash=? AND expires>?').get(hash(state),this.now());if(!row)fail(400,'Lượt đăng nhập không hợp lệ hoặc đã hết hạn.');const flow=JSON.parse(row.data);if(flow.provider!==provider)fail(400,'Dịch vụ đăng nhập không khớp.');this.db.prepare('DELETE FROM auth_flows WHERE state_hash=?').run(hash(state));
  if(body.error)return this.callbackLocation(flow,{error:'cancelled'});
  try {
   if(typeof body.code!=='string'||body.code.length>4096)throw Error('invalid code');const c=this.config;
   const form=new URLSearchParams({grant_type:'authorization_code',client_id:provider==='google'?c.googleId:c.appleId,client_secret:provider==='google'?c.googleSecret:await this.appleSecret(),code:body.code,redirect_uri:this.base+'/api/auth/callback/'+provider});if(provider==='google')form.set('code_verifier',flow.verifier);
   const response=await this.fetch(provider==='google'?'https://oauth2.googleapis.com/token':'https://appleid.apple.com/auth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('token exchange');const tokens=await response.json();
   const payload=this.verifyIdentity?await this.verifyIdentity(tokens.id_token,provider): (await jwtVerify(tokens.id_token,this.keys[provider],{issuer:provider==='google'?['https://accounts.google.com','accounts.google.com']:'https://appleid.apple.com',audience:provider==='google'?c.googleId:c.appleId,algorithms:['RS256']})).payload;
   if(payload.nonce!==flow.nonce||typeof payload.sub!=='string'||!payload.sub||payload.sub.length>255)throw Error('identity mismatch');
   let u=this.db.prepare('SELECT * FROM auth_users WHERE provider=? AND subject=?').get(provider,payload.sub);
   if(!u){const email=emailOf(payload.email);if(!validEmail(email)||![true,'true'].includes(payload.email_verified))throw Error('unverified identity email');const proposed=typeof payload.name==='string'?payload.name.slice(0,40):'';u={id:random(),email,name:proposed,password:null,provider,subject:payload.sub,verified:1,complete:0,created:this.now()};this.db.prepare('INSERT INTO auth_users VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(u));}
   const ticket=random();this.db.prepare('INSERT INTO auth_tickets VALUES(?,?,?,?)').run(hash(ticket),u.id,flow.challenge,this.now()+120000);this.db.prepare('DELETE FROM auth_tickets WHERE expires<?').run(this.now());return this.callbackLocation(flow,{ticket});
  }catch{return this.callbackLocation(flow,{error:'authentication_failed'});}
 }
 finishOAuth(body,ip){this.limit('finish:'+ip,40);if(typeof body.ticket!=='string'||body.ticket.length>200||typeof body.verifier!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.verifier))fail(400,'Lượt đăng nhập không hợp lệ.');const row=this.db.prepare('SELECT * FROM auth_tickets WHERE ticket_hash=? AND expires>?').get(hash(body.ticket),this.now());if(!row||row.challenge!==hash(body.verifier))fail(400,'Lượt đăng nhập không hợp lệ hoặc đã hết hạn.');this.db.prepare('DELETE FROM auth_tickets WHERE ticket_hash=?').run(hash(body.ticket));const u=this.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.user_id);return this.session(u);}
 async firebaseLogin(body,ip) {
  this.limit('firebase:'+ip,40);
  if(typeof body.idToken!=='string'||body.idToken.length>16000)fail(400,'Thiếu phiên Firebase.');
  const claims=await this.verifyFirebase(body.idToken);
  const subject=this.config.firebaseProjectId+':'+claims.sub;
  let u=this.db.prepare("SELECT * FROM auth_users WHERE provider='firebase' AND subject=?").get(subject);
  if(!u){
   const name=typeof claims.name==='string'?claims.name.trim().slice(0,40):'';
   u={id:random(),email:emailOf(claims.email),name,password:null,provider:'firebase',subject,verified:claims.email_verified===true?1:0,complete:name.length>=2?1:0,created:this.now()};
   this.db.prepare('INSERT INTO auth_users VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(u));
  }
  // A Firebase login is exchanged for the existing server session format.
  // Limit this session to the verified ID token lifetime.
  const result=this.session(u);
  result.expires=Math.min(result.expires,claims.exp*1000);
  this.db.prepare('UPDATE auth_sessions SET expires=? WHERE token_hash=?').run(result.expires,hash(result.token));
  return result;
 }
 async route(action,method,body,token,ip){
  if(method==='GET'&&action==='config')return this.capabilities();
  if(method==='GET'&&action==='me')return {user:this.publicUser(this.user(token))};
  if(method!=='POST')fail(405,'Phương thức không hợp lệ.');
  if(action==='otp/request')return this.requestLoginOtp(body,ip);
  if(action==='otp/verify')return this.verifyLoginOtp(body,ip);
  switch(action){case 'firebase':return this.firebaseLogin(body,ip);case 'register':return this.register(body,ip);case 'login':return this.login(body,ip);case 'logout':return this.logout(token);case 'profile':return this.profile(token,body);case 'password':return this.changePassword(token,body);case 'code/request':return this.requestCode(body,ip,token);case 'code/confirm':return this.confirmCode(body,ip,token);case 'oauth/start':return this.startOAuth(body,ip);case 'oauth/finish':return this.finishOAuth(body,ip);default:fail(404,'Không tìm thấy chức năng đăng nhập.');}
 }
}
