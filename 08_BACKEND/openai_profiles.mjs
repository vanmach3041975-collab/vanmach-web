import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PROVIDERS = new Set(['openai', 'gemini']);

function detectProvider(apiKey, fallback = 'openai') {
 if (typeof apiKey === 'string') {
  if (apiKey.startsWith('AIza')) return 'gemini';
  if (apiKey.startsWith('sk-')) return 'openai';
 }
 return PROVIDERS.has(fallback) ? fallback : 'openai';
}

export class OpenAIProfiles {
 constructor(db,{keyFile=null,fallbackKey='',fallbackModel='gpt-5-mini',fallbackProvider=''}={}){
  this.db=db;
  this.fallbackKey=fallbackKey;
  this.fallbackModel=fallbackModel;
  this.fallbackProvider=detectProvider(fallbackKey, fallbackProvider || 'openai');
  if(keyFile){
   fs.mkdirSync(path.dirname(keyFile),{recursive:true});
   if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,crypto.randomBytes(32),{mode:0o600,flag:'wx'});
   this.key=fs.readFileSync(keyFile);
  }else this.key=crypto.randomBytes(32);
  if(this.key.length!==32)throw new Error('Invalid local encryption key');
  db.exec("CREATE TABLE IF NOT EXISTS ai_profiles(id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'openai', model TEXT NOT NULL, encrypted TEXT NOT NULL, hint TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0)");
  const cols=db.prepare('PRAGMA table_info(ai_profiles)').all();
  if(!cols.some(c=>c.name==='provider')){
   db.exec("ALTER TABLE ai_profiles ADD COLUMN provider TEXT NOT NULL DEFAULT 'openai'");
  }
 }
 encrypt(value){const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});}
 decrypt(value){const v=JSON.parse(value);const cipher=crypto.createDecipheriv('aes-256-gcm',this.key,Buffer.from(v.iv,'base64'));cipher.setAuthTag(Buffer.from(v.tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(v.data,'base64')),cipher.final()]).toString('utf8');}
 list(){return this.db.prepare('SELECT id,name,provider,model,hint,active FROM ai_profiles ORDER BY name').all().map(p=>({...p,provider:p.provider||'openai',active:!!p.active}));}
 get(id){const p=this.db.prepare('SELECT * FROM ai_profiles WHERE id=?').get(id);if(!p)throw new Error('Không tìm thấy hồ sơ.');return {id:p.id,name:p.name,provider:p.provider||'openai',model:p.model,apiKey:this.decrypt(p.encrypted)};}
 config(){
  const p=this.db.prepare('SELECT * FROM ai_profiles WHERE active=1').get();
  return p
   ? {id:p.id,name:p.name,provider:p.provider||'openai',model:p.model,apiKey:this.decrypt(p.encrypted)}
   : {id:'environment',name:'Cấu hình môi trường',provider:this.fallbackProvider,model:this.fallbackModel,apiKey:this.fallbackKey};
 }
 save({id,name,provider,model,apiKey}){
  const old=id?this.db.prepare('SELECT * FROM ai_profiles WHERE id=?').get(id):null;
  if(id&&!old)throw new Error('Không tìm thấy hồ sơ cần sửa.');
  if(typeof name!=='string'||!name.trim()||name.length>60)throw new Error('Tên hồ sơ cần từ 1 đến 60 ký tự.');
  if(typeof model!=='string'||!/^[a-zA-Z0-9_.:-]{1,100}$/.test(model))throw new Error('Tên model không hợp lệ.');
  const value=apiKey||(old?this.decrypt(old.encrypted):'');
  const resolvedProvider=provider
   ? (PROVIDERS.has(provider)?provider:(() => {throw new Error('Nhà cung cấp AI không hợp lệ.');})())
   : detectProvider(value, old?.provider||'openai');
  if(resolvedProvider==='gemini'){
   if(typeof value!=='string'||!/^AIza[A-Za-z0-9_-]{20,200}$/.test(value))throw new Error('Khóa Gemini API chưa đúng định dạng (bắt đầu bằng AIza…).');
  }else{
   if(typeof value!=='string'||!/^sk-[A-Za-z0-9_-]{10,300}$/.test(value))throw new Error('Khóa OpenAI API chưa đúng định dạng (bắt đầu bằng sk-…).');
  }
  const profileId=id||crypto.randomUUID();
  this.db.prepare('INSERT INTO ai_profiles(id,name,provider,model,encrypted,hint,active) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,model=excluded.model,encrypted=excluded.encrypted,hint=excluded.hint').run(profileId,name.trim(),resolvedProvider,model,this.encrypt(value),'…'+value.slice(-4),old?.active??0);
  return profileId;
 }
 activate(id){
  if(!this.db.prepare('SELECT id FROM ai_profiles WHERE id=?').get(id))throw new Error('Không tìm thấy hồ sơ.');
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('UPDATE ai_profiles SET active=0').run();this.db.prepare('UPDATE ai_profiles SET active=1 WHERE id=?').run(id);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 remove(id){
  const p=this.db.prepare('SELECT * FROM ai_profiles WHERE id=?').get(id);
  if(!p)throw new Error('Không tìm thấy hồ sơ.');
  if(p.active)throw new Error('Hãy chuyển sang hồ sơ khác trước khi xóa hồ sơ đang dùng.');
  this.db.prepare('DELETE FROM ai_profiles WHERE id=?').run(id);
 }
}
