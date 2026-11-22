import {createRemoteJWKSet, jwtVerify} from 'jose';

// Only Firebase ID tokens issued to this project are accepted. Never trust UID
// or email supplied separately by the client, or merge accounts by email.
export function firebaseVerifier(projectId, keys = createRemoteJWKSet(new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
))) {
  return async token => {
    if (!projectId) throw Object.assign(new Error('Chưa cấu hình Firebase trên máy chủ.'), {status:503});
    try {
      const {payload} = await jwtVerify(token, keys, {
        algorithms:['RS256'], audience:projectId,
        issuer:`https://securetoken.google.com/${projectId}`,
        requiredClaims:['exp','iat','auth_time','sub'],
      });
      if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128 || !Number.isInteger(payload.auth_time) || payload.auth_time > Date.now()/1000 || payload.iat > Date.now()/1000) throw Error('invalid identity');
      return payload;
    } catch {
      throw Object.assign(new Error('Phiên Firebase không hợp lệ hoặc đã hết hạn. Hãy đăng nhập lại.'), {status:401});
    }
  };
}
