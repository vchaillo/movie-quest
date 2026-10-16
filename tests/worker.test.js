import test from 'node:test';import assert from 'node:assert/strict';import worker from '../worker/src/index.js';
const base='https://movie-quest.example';const req=(path,options={})=>new Request(base+path,options);
test('health works without TMDB secret',async()=>{const r=await worker.fetch(req('/health'),{});assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true})});
test('missing secret rejects TMDB requests',async()=>{const r=await worker.fetch(req('/api/search?q=film'),{});assert.equal(r.status,503)});
test('cross-origin requests are rejected',async()=>{const r=await worker.fetch(req('/api/search?q=film',{headers:{Origin:'https://attacker.example'}}),{TMDB_READ_TOKEN:'dummy'});assert.equal(r.status,403)});
test('preflight returns allowed origin',async()=>{const r=await worker.fetch(req('/api/search',{method:'OPTIONS'}),{});assert.equal(r.status,204);assert.equal(r.headers.get('Access-Control-Allow-Origin'),'https://vchaillo.github.io')});
test('unauthenticated requests cannot probe search routes',async()=>{const r=await worker.fetch(req('/api/search?q=test&type=unknown'),{TMDB_READ_TOKEN:'dummy'});assert.equal(r.status,401)});

test('TMDB endpoints reject requests without Firebase authorization',async()=>{const r=await worker.fetch(req('/api/search?q=film'),{TMDB_READ_TOKEN:'dummy'});assert.equal(r.status,401);assert.equal((await r.json()).error,'Authentication required')});
test('TMDB endpoints reject invalid Firebase tokens',async()=>{const r=await worker.fetch(req('/api/search?q=film',{headers:{Authorization:'Bearer invalid'}}),{TMDB_READ_TOKEN:'dummy'});assert.equal(r.status,401)});
