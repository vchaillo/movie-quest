// Verify Firebase ID tokens with Google's public signing keys (RS256).
const PROJECT_ID='movie-quest-cde3a';
const JWKS_URL='https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwksCache=null,expiresAt=0;
const decode=x=>{const raw=atob(x.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0))};
export async function verifyFirebaseToken(token,{fetchKeys=fetch,now=Date.now()}={}){
 if(!token||token.length>8192)throw Error('Missing token');
 const parts=token.split('.');if(parts.length!==3)throw Error('Malformed token');
 let header,payload;
 try{header=JSON.parse(new TextDecoder().decode(decode(parts[0])));payload=JSON.parse(new TextDecoder().decode(decode(parts[1])))}catch{throw Error('Malformed token')}
 if(header.alg!=='RS256'||!header.kid)throw Error('Invalid algorithm');
 const nowSeconds=Math.floor(now/1000);
 if(payload.aud!==PROJECT_ID||payload.iss!=='https://securetoken.google.com/'+PROJECT_ID||!payload.sub||payload.sub.length>128||!Number.isFinite(payload.exp)||payload.exp<=nowSeconds||!Number.isFinite(payload.iat)||payload.iat>nowSeconds+60||!Number.isFinite(payload.auth_time)||payload.auth_time>nowSeconds+60)throw Error('Invalid claims');
 if(!jwksCache||now>=expiresAt){
  const response=await fetchKeys(JWKS_URL);
  if(!response.ok)throw Error('Public keys unavailable');
  jwksCache=await response.json();
  const maxAge=Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1]||300);
  expiresAt=now+Math.min(Math.max(maxAge,60),3600)*1000;
 }
 const key=jwksCache.keys?.find(k=>k.kid===header.kid&&k.kty==='RSA'&&k.alg==='RS256'&&k.use==='sig');
 if(!key)throw Error('Signing key not found');
 const publicKey=await crypto.subtle.importKey('jwk',key,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 const valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',publicKey,decode(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
 if(!valid)throw Error('Invalid signature');
 return payload;
}
