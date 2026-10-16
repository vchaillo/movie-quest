import {verifyFirebaseToken} from './firebase-auth.js';
// Movie Quest TMDB proxy — Cloudflare Workers (no Node server required).
const ALLOWED_ORIGIN = 'https://vchaillo.github.io';
const TMDB = 'https://api.themoviedb.org/3';
const json = (body, status=200, extra={}) => new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'public, max-age=300',...extra}});
export default {
 async fetch(request, env, ctx) {
  const origin=request.headers.get('Origin');
  const cors={'Access-Control-Allow-Origin':ALLOWED_ORIGIN,'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Vary':'Origin'};
  if(request.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  if(request.method!=='GET')return json({error:'Method not allowed'},405,cors);
  if(origin && origin!==ALLOWED_ORIGIN)return json({error:'Origin not allowed'},403,cors);
  const u=new URL(request.url), parts=u.pathname.split('/').filter(Boolean);
  if(u.pathname==='/health')return json({ok:true},200,cors);
  if(!env.TMDB_READ_TOKEN)return json({error:'TMDB secret not configured'},503,cors);
  const authorization=request.headers.get('Authorization')||'';
  if(!authorization.startsWith('Bearer '))return json({error:'Authentication required'},401,cors);
  try { await verifyFirebaseToken(authorization.slice(7)); } catch(e) { return json({error:'Invalid or expired Firebase session'},401,cors); }
  try {
  let endpoint='',params=new URLSearchParams({language:'fr-FR'});
  if(u.pathname==='/api/search'){
   const q=(u.searchParams.get('q')||'').trim().slice(0,100);
   if(!q)return json({results:[]},200,cors);
   const type=u.searchParams.get('type')||'all';
   if(!['all','actor','director','movie'].includes(type))return json({error:'Invalid type'},400,cors);
   const [people,movies]=await Promise.all([
    type==='movie'?Promise.resolve({results:[]}):tmdb('/search/person',{query:q},env),
    type==='all'||type==='movie'?tmdb('/search/movie',{query:q},env):Promise.resolve({results:[]})
   ]);
   const results=[];
   for(const p of people.results||[]){
    if((type==='all'||type==='actor')&&(p.known_for_department==='Acting'||type==='actor'))results.push({id:p.id,name:p.name,role:'actor',profile_path:p.profile_path});
    if((type==='all'||type==='director')&&(p.known_for_department==='Directing'||type==='director'))results.push({id:p.id,name:p.name,role:'director',profile_path:p.profile_path});
   }
   for(const m of movies.results||[])results.push({...m,role:'movie'});
   return json({results:results.slice(0,40)},200,cors);
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='person'&&parts[3]==='movies'){
   const id=parts[2];if(!/^\d{1,12}$/.test(id))return json({error:'Invalid person ID'},400,cors);
   const role=u.searchParams.get('role')==='director'?'director':'actor';
   const [profile,credits]=await Promise.all([tmdb('/person/'+id,{},env),tmdb('/person/'+id+'/movie_credits',{},env)]);
   const items=role==='director'?(credits.crew||[]).filter(m=>m.job==='Director'):(credits.cast||[]);
   const movies=[...new Map(items.filter(m=>m.id&&m.title&&m.release_date).map(m=>[m.id,m])).values()].sort((a,b)=>b.release_date.localeCompare(a.release_date));
   return json({profile,movies},200,cors);
  }
  if(parts.length===3&&parts[0]==='api'&&parts[1]==='movie'&&/^\d{1,12}$/.test(parts[2])){
   try{return json(await tmdb('/movie/'+parts[2],{},env),200,cors)}catch(e){return json({error:'TMDB unavailable'},502,cors)}
  }
  return json({error:'Not found'},404,cors);
  } catch (error) {
   console.error('TMDB proxy request failed', error);
   return json({error:'TMDB request failed'},502,cors);
  }
 }
};
async function tmdb(path,values,env){
 const url=new URL(TMDB+path);url.searchParams.set('language','fr-FR');
 for(const [k,v] of Object.entries(values))url.searchParams.set(k,v);
 const response=await fetch(url,{headers:{Authorization:'Bearer '+env.TMDB_READ_TOKEN,Accept:'application/json'},cf:{cacheTtl:300,cacheEverything:true}});
 if(!response.ok)throw new Error('TMDB status '+response.status);
 return response.json();
}
