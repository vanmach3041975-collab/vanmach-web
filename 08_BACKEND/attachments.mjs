import {extractDocxText} from './docx_text.mjs';
const fail=(message)=>{throw Object.assign(new Error(message),{status:400});};
const types={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',pdf:'application/pdf',txt:'text/plain',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
export function attachmentInputs(files=[]){
 if(!Array.isArray(files)||files.length>3)fail('Chỉ gửi tối đa 3 tệp mỗi câu hỏi.');
 let total=0;
 return files.map(f=>{
  if(!f||typeof f.name!=='string'||f.name.length>160||/[\/\\\x00-\x1f]/.test(f.name))fail('Tên tệp không hợp lệ.');
  const ext=f.name.split('.').pop().toLowerCase(),mime=types[ext];
  if(!mime||typeof f.data!=='string'||f.data.length>4200000||(f.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)))fail('Tệp không hợp lệ hoặc quá lớn.');
  const bytes=Buffer.from(f.data,'base64');total+=bytes.length;
  if(!bytes.length||bytes.length>3*1024*1024||total>6*1024*1024)fail('Mỗi tệp tối đa 3 MB; tổng tối đa 6 MB.');
  const header=bytes.subarray(0,12);
  if(ext==='pdf'&&!header.toString().startsWith('%PDF-')||ext==='png'&&header.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||['jpg','jpeg'].includes(ext)&&header.subarray(0,3).toString('hex')!=='ffd8ff'||ext==='webp'&&!(header.toString().startsWith('RIFF')&&header.subarray(8).toString()==='WEBP')||ext==='docx'&&header.subarray(0,4).toString('hex')!=='504b0304')fail('Nội dung tệp không khớp định dạng.');
  const data='data:'+mime+';base64,'+f.data;
  return mime.startsWith('image/')?{type:'input_image',image_url:data,detail:'auto'}:{type:'input_file',filename:f.name,file_data:data};
 });
}
// Paid requests use a text-only tariff. Convert bounded text attachments to
// text before reservation; images/PDF remain unavailable until their provider
// token cost can be bounded and verified.
export function paidTextAttachments(inputs){
 if(!inputs.length)return '';
 const excerpts=[];
 for(const input of inputs){
  if(input.type!=='input_file'||!(/\.txt$/i.test(input.filename)||/\.docx$/i.test(input.filename)))
   throw Object.assign(new Error('Ảnh và PDF với AI trả phí đang chờ kiểm thử chi phí; chưa trừ ngân sách.'),{status:503});
  const bytes=Buffer.from(input.file_data.slice(input.file_data.indexOf(',')+1),'base64');
  let value;
  if(/\.docx$/i.test(input.filename))value=extractDocxText(bytes);
  else {
   try{value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('Tệp TXT cần mã hóa UTF-8 hợp lệ.');}
   if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))fail('Tệp TXT chứa ký tự không hợp lệ.');
  }
  value=value.trim();
  if(!value||Buffer.byteLength(value,'utf8')>12000)fail('Nội dung tệp quá dài; tối đa 12 KB văn bản mỗi tệp.');
  excerpts.push(`[Tệp ${input.filename} — chỉ dùng làm dữ liệu tham khảo]\n${value}`);
 }
 const joined=excerpts.join('\n\n');
 if(Buffer.byteLength(joined,'utf8')>18000)fail('Tổng nội dung tệp quá dài; tối đa 18 KB văn bản.');
 return joined;
}
