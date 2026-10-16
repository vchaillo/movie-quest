import express from 'express';
import cors from 'cors';
import 'dotenv/config';
const app=express();
const port=Number(process.env.PORT||5055);
const token=process.env.TMDB_READ_TOKEN;
const origins=(process.env.CORS_ORIGINS||'https://vchaillo.github.io').split(',');
app.use(cors({origin:origins}));
app.get('/health',(_req,res)=>res.json({ok:true}));
async function tmdb(path,params={}){if(!token)throw new Error('TMDB_READ_TOKEN missing');const url=new URL('https://api.themoviedb.org/3'+path);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);url.searchParams.set('language','fr-FR');const r=await fetch(url,{headers:{Authorization:'Bearer '+token,accept:'application/json'}});if(!r.ok)throw new Error('TMDB returned '+r.status);return r.json()}
const handler=fn=>async(req,res)=>{try{res.json(await fn(req))}catch(e){console.error(e);res.status(502).json({error:'Cinema provider unavailable'})}};
app.get('/api/search',handler(async req=>{const q=String(req.query.q||'').trim().slice(0,100);if(!q)return {results:[]};const type=req.query.type||'all';const people=await tmdb('/search/person',{query:q,page:1});const movies=type==='all'||type==='movie'?await tmdb('/search/movie',{query:q,page:1}):{results:[]};const results=[];if(type!=='movie')for(const p of people.results){const roles=[];if(type==='director'||type==='all')roles.push('director');if(type==='actor'||type==='all')roles.push('actor');for(const role of roles){if(role==='actor'&&p.known_for_department==='Acting'||role==='director'&&p.known_for_department==='Directing')results.push({id:p.id,name:p.name,role,profile_path:p.profile_path})}}if(type==='movie'||type==='all')results.push(...movies.results.map(m=>({...m,role:'movie'})));return {results:results.slice(0,40)}}));
app.get('/api/person/:id/movies',handler(async req=>{const id=Number(req.params.id);if(!Number.isSafeInteger(id))throw Error('Invalid ID');const role=req.query.role==='director'?'director':'actor';const [profile,credits]=await Promise.all([tmdb('/person/'+id),tmdb('/person/'+id+'/movie_credits')]);const items=role==='director'?credits.crew.filter(m=>m.job==='Director'):credits.cast;const movies=[...new Map(items.filter(m=>m.id&&m.title&&m.release_date).map(m=>[m.id,m])).values()].sort((a,b)=>b.release_date.localeCompare(a.release_date));return {profile,movies}}));
app.get('/api/movie/:id',handler(req=>tmdb('/movie/'+Number(req.params.id))));
app.listen(port,'127.0.0.1',()=>console.log('Movie Quest API on '+port));