import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function validateCredentials(input){
 const values={};
 for(const field of ['clientId','apiKey','checksumKey']){
  const value=input?.[field];
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{16,256}$/.test(value.trim())){
   throw Object.assign(new Error('Cần nhập đủ Client ID, API Key và Checksum Key hợp lệ từ cùng kênh payOS.'),{status:400});
  }
  values[field]=value.trim();
 }
 return values;
}

// One secret value keeps the three credentials from different channels from mixing.
export function paymentCredentialsFromEnvironment(env=process.env){
 if(env.PAYOS_CREDENTIALS===undefined)return null;
 try{return validateCredentials(JSON.parse(env.PAYOS_CREDENTIALS));}
 catch{throw new Error('PAYOS_CREDENTIALS is invalid; configure all three credentials together.');}
}

export class PaymentSettings {
 constructor(db,{keyFile=null,cloudCredentials=null}={}) {
  this.db=db;
  this.cloudCredentials=cloudCredentials===null?null:Object.freeze(validateCredentials(cloudCredentials));
  if(keyFile){
   fs.mkdirSync(path.dirname(keyFile),{recursive:true});
   try{fs.writeFileSync(keyFile,crypto.randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
   this.key=fs.readFileSync(keyFile);
  }else this.key=crypto.randomBytes(32);
  if(this.key.length!==32)throw new Error('Invalid payment encryption key');
  db.exec('CREATE TABLE IF NOT EXISTS payment_settings(id INTEGER PRIMARY KEY CHECK(id=1), encrypted TEXT NOT NULL, updated TEXT NOT NULL)');
 }
 status(){
  const row=this.db.prepare('SELECT updated FROM payment_settings WHERE id=1').get();
  return {configured:!!(this.cloudCredentials||row),updatedAt:this.cloudCredentials?null:row?.updated??null,paymentsEnabled:false,connectionVerified:false};
 }
 save(input){
  if(this.cloudCredentials)throw Object.assign(new Error('Cấu hình payOS được quản lý bởi máy chủ.'),{status:409});
  const values=validateCredentials(input);
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);
  cipher.setAAD(Buffer.from('vanmach:payos:v1'));
  const data=Buffer.concat([cipher.update(JSON.stringify(values),'utf8'),cipher.final()]);
  const encrypted=JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
  this.db.prepare('INSERT INTO payment_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted,updated=excluded.updated')
   .run(encrypted,new Date().toISOString());
  return this.status();
 }
 // Server use only; never expose this method through the administration API.
 read(){
  if(this.cloudCredentials)return {...this.cloudCredentials};
  const row=this.db.prepare('SELECT encrypted FROM payment_settings WHERE id=1').get();
  if(!row)return null;
  const value=JSON.parse(row.encrypted),decipher=crypto.createDecipheriv('aes-256-gcm',this.key,Buffer.from(value.iv,'base64'));
  decipher.setAAD(Buffer.from('vanmach:payos:v1'));decipher.setAuthTag(Buffer.from(value.tag,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data,'base64')),decipher.final()]).toString('utf8'));
 }
}
