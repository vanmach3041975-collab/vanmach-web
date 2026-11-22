import nodemailer from 'nodemailer';

export function mailDelivery(config,fetchImpl=fetch){
 if(config.resendApiKey){
  if(!config.mailFrom)throw Error('MAIL_FROM is required for email delivery');
  return async message=>{
   try{
    const response=await fetchImpl('https://api.resend.com/emails',{
     method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
     headers:{Authorization:'Bearer '+config.resendApiKey,'Content-Type':'application/json'},
     body:JSON.stringify({from:config.mailFrom,to:[message.to],subject:message.subject,text:message.text}),
    });
    if(!response.ok)throw Error('Provider rejected delivery');
    const result=await response.json();
    if(typeof result.id!=='string'||!result.id)throw Error('Missing delivery receipt');
    return {messageId:result.id};
   }catch{
    // Never surface provider payloads containing addresses, codes or credentials.
    throw Object.assign(new Error('Chưa gửi được email. Vui lòng thử lại sau.'),{status:503});
   }
  };
 }
 if(!config.smtpHost||!config.mailFrom)return null;
 const transport=nodemailer.createTransport({host:config.smtpHost,port:config.smtpPort,
  secure:config.smtpPort===465,requireTLS:config.smtpPort!==465,
  auth:config.smtpUser?{user:config.smtpUser,pass:config.smtpPassword}:undefined});
 return async message=>{
  try{return await transport.sendMail({...message,from:config.mailFrom});}
  catch{throw Object.assign(new Error('Chưa gửi được email. Vui lòng thử lại sau.'),{status:503});}
 };
}
