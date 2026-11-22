import crypto from 'node:crypto';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export class FreeAccess {
 constructor(db,{now=Date.now}={}){this.db=db;this.now=now;
  db.exec(`CREATE TABLE IF NOT EXISTS free_requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS verified_ad_rewards(event_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL);`);
 }
 reserve(userId,kind,{adFree=false}={}){
  const cap=kind==='ai'?3:kind==='room'?2:0;if(!cap)fail(400,'Loại lượt dùng không hợp lệ.');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.prepare("DELETE FROM free_requests WHERE state='pending' AND expires<=?").run(this.now());
   const used=this.db.prepare('SELECT count(*) AS n FROM free_requests WHERE user_id=? AND kind=?').get(userId,kind).n;
   if(used>=cap)fail(429,`Bạn đã dùng hết ${cap} lượt ${kind==='ai'?'AI':'tạo phòng'} miễn phí suốt đời tài khoản.`);
   const rewards=this.db.prepare('SELECT count(*) AS n FROM verified_ad_rewards WHERE user_id=? AND kind=?').get(userId,kind).n;
   if(!adFree&&used>=Math.min(1+rewards,cap))fail(503,'Lượt tiếp theo cần xem quảng cáo. Dịch vụ quảng cáo chưa được cấu hình; hiện chưa thể mở thêm lượt.');
   const id=crypto.randomUUID();this.db.prepare("INSERT INTO free_requests VALUES(?,?,?,'pending',?)").run(id,userId,kind,this.now()+120000);
   this.db.exec('COMMIT');return id;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 finish(id){this.db.prepare("UPDATE free_requests SET state='success' WHERE id=?").run(id);}
 cancel(id){this.db.prepare("DELETE FROM free_requests WHERE id=? AND state='pending'").run(id);}
 // Called only by a future provider's server-side signature verifier, never a client claim.
 recordVerifiedReward(eventId,userId,kind){
  if(!['ai','room'].includes(kind)||!eventId||!userId)fail(400,'Phần thưởng không hợp lệ.');
  this.db.prepare('INSERT OR IGNORE INTO verified_ad_rewards VALUES(?,?,?)').run(eventId,userId,kind);
 }
}
