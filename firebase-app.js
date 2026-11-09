import {openMovieGallery} from './movie-gallery.js';
import {completion,recentSeen,byMonth} from './stats.js';
import {initializeApp} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {getAuth,GoogleAuthProvider,signInWithPopup,signOut,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {getFirestore,doc,getDoc,setDoc,onSnapshot,updateDoc,arrayUnion,arrayRemove,FieldPath} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
const firebaseConfig={apiKey:"AIzaSyDU-l_qBPCzZwwNaYK5khBeoVYjG_e670k",authDomain:"movie-quest-cde3a.firebaseapp.com",projectId:"movie-quest-cde3a",storageBucket:"movie-quest-cde3a.firebasestorage.app",messagingSenderId:"632772720590",appId:"1:632772720590:web:1b94784b74e3b59b0a5d9f"};
const auth=getAuth(initializeApp(firebaseConfig)),db=getFirestore(auth.app),provider=new GoogleAuthProvider();
const API=localStorage.getItem('moviequest-api-origin')||'https://movie-quest.valentinchaillou89.workers.dev';
let authReady=false,user=null,unsub=null,tab='explore',query='',filter='all',view='list',selected=null,film=null,results=[],loading=false,error='',people=new Map(),filmCache=new Map();
let seriesId=null;
const savedLayout=(()=>{try{return JSON.parse(localStorage.getItem('moviequest-layout')||'null')}catch{return null}})();
const librarySections = {
 collections: {slug:'collections', label:'Collections', icon:'cards'},
 lists: {slug:'lists', label:'Listes', icon:'collection'},
 queue: {slug:'to-complete', label:'À compléter', icon:'later'},
 watched: {slug:'watched', label:'Vus', icon:'eye'},
};
const mainTabs = ['explore','now-playing','following','stats','profile'];
const isLibraryTab = value => Object.hasOwn(librarySections,value);
// Keep the header entry compatible with cached HTML and JavaScript during deployments.
const isLibraryEntry = value => value==='lists'||value==='library';
const savedView=(()=>{try{return JSON.parse(sessionStorage.getItem('moviequest-view')||'null')}catch{return null}})();
function routeFromHash(){
 const match=location.hash.match(/^#\/(library(?:\/(collections|lists|to-complete|watched))?|explore|now-playing|series|following|lists|queue|watched|stats|profile)(?:\/(film|person|tv)\/(\d+))?$/);
 if(!match)return null;
 const [,path,section,kind,id]=match;
 const routeTab=path.startsWith('library')
  ? Object.keys(librarySections).find(key=>librarySections[key].slug===section)||'collections'
  : ({lists:'collections',series:'explore'}[path]||path);
 return {tab:routeTab,film:kind==='film'?Number(id):null,selected:kind==='person'?Number(id):null,tv:kind==='tv'?Number(id):null};
}
function applyRoute(route){
 tab=route.tab;
 film=Number(route.film)||null;
 selected=Number(route.selected)||null;
 seriesId=Number(route.tv)||null;
}
const initialRoute=routeFromHash();
if(initialRoute)applyRoute(initialRoute);
else if(savedView){
 const savedTab=savedView.tab==='series'?'explore':savedView.tab;
 if(mainTabs.includes(savedTab)||isLibraryTab(savedTab))applyRoute({...savedView,tab:savedTab});
}
let lastRoute=location.hash;
let seriesQuery='',seriesResults=[],seriesView='cards',seriesFilter='all',seriesLoading=false,seriesError='',seriesCache=new Map(),seriesSeasonCache=new Map(),personSeriesCache=new Map(),seriesSearchTimer,seriesSearchSeq=0;
function routeUrl(){
 const path=isLibraryTab(tab)?'library/'+librarySections[tab].slug:tab;
 return '#/'+path+(seriesId?'/tv/'+seriesId:film?'/film/'+film:selected?'/person/'+selected:'');
}
function syncRoute(replace=false){
 const next=routeUrl();
 if(next!==location.hash)history[replace?'replaceState':'pushState']({movieQuest:true},'',next);
 lastRoute=next;
}
if(initialRoute)syncRoute(true);

const sectionLoads=new Map();

function refreshLoadingSection(key){
 const current=seriesId?'tv:'+seriesId:film?'movie:'+film:selected?'person:'+selected:tab;
 const followingLoad=key==='following-movies'||key==='following-series';
 if(current==='queue'&&(key==='queue'||followingLoad)){
  updateFilterResults('queueSearch');
  return;
 }
 if(current==='watched'&&(key==='watched'||(key==='following-series'&&watchedMediaTab==='series'))){
  updateFilterResults('watchedSearch');
  return;
 }
 if(current==='explore'&&(followingLoad||key==='on-air')){
  const section=document.getElementById('suggestions');
  if(section&&key===followingLoadKey(exploreSuggestionTab))section.outerHTML=exploreSuggestionTab==='films'?suggestionMarkup():exploreSuggestionTab==='series'?seriesSuggestionsMarkup():exploreSuggestionTab==='spectacles'?spectacleSuggestionsMarkup():documentarySuggestionsMarkup();
  updateFilterResults('releaseSearch');
  return;
 }
 if(current===key||(selected&&key==='person-series:'+selected&&personMediaTab==='series')||
  (followingLoad&&['following','now-playing','stats'].includes(current))||
  (current==='stats'&&key==='stats-history'))render();
}

function loadSection(key,work,resources=[]){
 const current=sectionLoads.get(key);
 const owner=user;
 if(current){
  if(resources.every(id=>current.resources.has(id)))return current.job;
  // A library edit can add resources while the current batch is in flight.
  return current.job.then(()=>user===owner?loadSection(key,work,resources):undefined);
 }
 const entry={resources:new Set(resources)};
 entry.job=Promise.resolve().then(()=>user===owner?work():undefined).finally(()=>{
  if(sectionLoads.get(key)!==entry)return;
  sectionLoads.delete(key);
  refreshLoadingSection(key);
 });
 sectionLoads.set(key,entry);
 refreshLoadingSection(key);
 return entry.job;
}

function loadingDots(){
 return '<span class="mq-loading-pulse" aria-hidden="true"><i></i><i></i><i></i></span>';
}

function loadingContent(pending,label,content='',hasContent=false,mode='list'){
 if(!pending)return content;
 const status='<div class="mq-local-status" role="status">'+loadingDots()+'<span>'+esc(label)+'</span></div>';
 if(hasContent)return status+content;
 const skeleton='<span class="mq-loading-shape"><i></i><span><i></i><i></i></span></span>';
 return '<div class="mq-local-loading">'+status+
  '<div class="mq-loading-preview mq-loading-'+mode+'" aria-hidden="true">'+skeleton.repeat(mode==='detail'?1:4)+'</div></div>';
}

function loadFilm(id){
 if(filmCache.get(id)?.credits)return;
 return loadSection('movie:'+id,async()=>{
  try{filmCache.set(id,await request('/api/movie/'+id))}
  catch(e){if(film===id)error=e.message}
 });
}

const followingLoadKey=media=>media==='series'?'following-series':'following-movies';
const followingIsLoading=media=>sectionLoads.has(followingLoadKey(media));

function needsFollowing(media){
 if(selected||film||seriesId)return false;
 switch(tab){
  case 'explore': return [exploreSuggestionTab,releaseMediaTab].some(value=>followingLoadKey(value)===followingLoadKey(media));
  case 'queue': return followingLoadKey(queueMediaTab)===followingLoadKey(media);
  case 'watched': return watchedMediaTab==='series'&&media==='series';
  case 'following': return media==='movies';
  case 'now-playing':
  case 'stats': return true;
  default: return false;
 }
}

async function loadRouteContent(){
 if(seriesId){await loadSeries(seriesId);return}
 if(film){await loadFilm(film);return}
 if(selected){
  const id=selected;
  if(personMediaTab==='series'){await loadPersonSeries(id);return}
  const person=state.following[id]||knownPeople.get(id)||{id,name:'Filmographie',role:'actor'};
  currentPerson=person;
  await loadPerson(person);
  return;
 }
 const tasks=['movies','series'].filter(needsFollowing).map(loadFollowing);
 switch(tab){
  case 'explore':
   if(releaseMediaTab==='series'&&followed().length)tasks.push(loadOnAirSeries());
   break;
  case 'now-playing': tasks.push(loadNowPlaying());break;
  case 'collections': tasks.push(hydrateSagas());break;
  case 'lists': tasks.push(hydrateListContent());break;
  case 'queue':
   if(queueMediaTab!=='series')tasks.push(hydrateSavedMovies(['todo'],'queue'));
   break;
  case 'watched':
   if(watchedMediaTab!=='series')tasks.push(hydrateWatchedMovies());
   break;
  case 'stats':
   await Promise.all(tasks);
   if(tab==='stats'&&!selected&&!film&&!seriesId)await hydrateSavedMovies(['seen','todo'],'stats-history');
   return;
 }
 await Promise.all(tasks);
}

async function navigateHistory(){
 if(location.hash===lastRoute)return;
 applyRoute(routeFromHash()||{tab:'explore'});
 error='';
 currentPerson=null;
 syncRoute(true);
 render();
 try{await loadRouteContent()}catch(e){error=e.message;render()}
}
window.addEventListener('popstate',()=>{if(user)navigateHistory()});
let menuOpen=false,mobileNavOpen=false;const ACCENTS=['#3bdd0e','#e7bc75','#f97373','#ff9650','#77c79a','#59b6cb','#6f9fff','#a48cf1','#ef8ab9'];
let nowPlaying=[],upcomingMovies=[],nowLoaded=false,nowView='cards',searchSeq=0;let currentPerson=null;const knownPeople=new Map();let followingRole='all',followingQuery='',personFilmRole='all',personFilmQuery='',personSeriesQuery='',castQuery='',nowQuery='',releaseQuery='',queueQuery='';let watchedMediaTab='films',watchedQuery='',watchedSort='recent',watchedSeriesSort='title';let castView='cards';let personMediaTab='films',exploreSuggestionTab='films',releaseMediaTab='films',queueMediaTab='films';let documentaryPage=0;const mediaPages={release:0,upcoming:0,current:0,spectacles:0,queue:0,watched:0};let suggestionPage=0,suggestionGenres=[],suggestionDecades=[],suggestionFiltersOpen=false,suggestionMinYear=1900,suggestionMaxYear=2030,suggestionRuntime='all',suggestionCountries=[],filterMetadataLoading=false;const personRequests=new Map();let followingView='cards',releaseView='cards',releaseRole='all',releasePerson='all';let state={following:{},statuses:{},dismissed:{},seenAt:{},series:{},lists:{},preferences:{accent:'#3bdd0e'}};let exploreView='cards';if(savedLayout){const valid=v=>v==='cards'||v==='list';if(valid(savedLayout.mode)){view=savedLayout.mode;exploreView=savedLayout.mode;followingView=savedLayout.mode;releaseView=savedLayout.mode;nowView=savedLayout.mode;castView=savedLayout.mode;seriesView=savedLayout.mode}}const el=document.getElementById('app'),esc=x=>String(x??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','"':'&quot;'}[c])),poster=(path,size='w342')=>path?'https://image.tmdb.org/t/p/'+size+path:'';
const followed=()=>Object.values(state.following).map(p=>{const profile=people.get(p.id)?.profile||knownPeople.get(p.id)||{};return {...p,name:(p.name&&p.name!=='Personnalité'?p.name:profile.name)||p.name||'Personnalité',profile_path:p.profile_path||profile.profile_path||null}}),films=()=>[...filmCache.values()];
const isSpectacle=m=>{
 const title=(m.original_title||m.title||'').toLowerCase();
 const genres=(m.genre_ids||m.genres?.map(g=>g.id)||[]).map(Number);
 const keywords=(m.keywords?.keywords||m.keywords?.results||[]).map(k=>k.name?.toLowerCase()||'').join(' ');
 const text=title+' '+keywords;
 return /stand[ -]?up|one[ -]?man[ -]?show|one[ -]?woman[ -]?show|spectacle|sur scène|sur scene|live in concert|live at |en concert|concert live|concert film|comedy special|comedy show|théâtre|theatre|pièce de théâtre|stage play|ballet|opéra|opera|broadway|comédie musicale|musical live|live performance/i.test(text)
  ||(genres.includes(10770)&&/concert|stage|theatre|comedy special/i.test(text));
};
const bonusCategory=m=>{if(isSpectacle(m))return null;const genres=m.genre_ids||m.genres?.map(g=>g.id)||[];if(genres.map(Number).includes(99))return 'Documentaire';const name=(m.original_title||m.title||'').toLowerCase();return /making[ -]?of|behind.the.scenes|featurette|bloopers|outtakes|on the set|les coulisses|dans les coulisses|sur le tournage|bonus|documentary|documentaire|interview|cast reunion|reunion special/i.test(name)?'Making-of / bonus':null};
const isFeatureFilm=m=>!bonusCategory(m)&&!isSpectacle(m);
const matchesMovieTab=(m,tab)=>tab==='spectacles'?isSpectacle(m):tab==='documentaries'?!!bonusCategory(m):isFeatureFilm(m);
let followedCredits=null;
function followedMovieCredits(){
 if(followedCredits)return followedCredits;
 followedCredits=new Map();
 for(const person of followed()){
  for(const movie of people.get(person.id)?.movies||[]){
   const id=Number(movie.id);
   if(!followedCredits.has(id))followedCredits.set(id,movie);
  }
 }
 return followedCredits;
}
const status=id=>{
 if(state.statuses[id])return state.statuses[id];
 const related=followedMovieCredits().get(Number(id));
 return related&&isFeatureFilm(filmCache.get(Number(id))||related)?'todo':'none';
};
const complete=list=>list.filter(m=>['seen','skip'].includes(status(m.id))).length;
const followedMovieIndex=()=>[...followedMovieCredits()].map(([id,movie])=>filmCache.get(id)||movie);
const queueMovies=()=>{
 const byId=new Map(followedMovieIndex().filter(m=>(state.statuses[m.id]||'todo')==='todo').map(m=>[Number(m.id),m]));
 for(const [key,value] of Object.entries(state.statuses||{})){
  if(value!=='todo'||!/^[0-9]+$/.test(key))continue;
  const id=Number(key),movie=filmCache.get(id);
  if(movie)byId.set(id,movie);
 }
 return [...byId.values()];
};
function hydrateSavedMovies(statuses,section){
 const ids=Object.entries(state.statuses||{})
  .filter(([id,value])=>statuses.includes(value)&&/^[0-9]+$/.test(id)&&!filmCache.has(Number(id)))
  .map(([id])=>Number(id));
 if(!ids.length)return;
 const owner=user;
 return loadSection(section,async()=>{
  const activeTab=section==='stats-history'?'stats':section;
  for(let i=0;i<ids.length&&user===owner&&tab===activeTab&&!selected&&!film&&!seriesId;i+=5){
   if((activeTab==='queue'&&queueMediaTab==='series')||(activeTab==='watched'&&watchedMediaTab==='series'))break;
   await Promise.allSettled(ids.slice(i,i+5).map(async id=>{
    if(!filmCache.has(id))filmCache.set(id,await request('/api/movie/'+id));
   }));
  }
 },ids);
}

const pendingRequests=new Map();
function request(path){
 const owner=user;
 if(!owner)return Promise.reject(Error('Connexion requise'));
 if(pendingRequests.has(path))return pendingRequests.get(path);
 const job=(async()=>{
  const token=await owner.getIdToken();
  if(user!==owner)throw Error('Session modifiée');
  const response=await fetch(API+path,{headers:{Authorization:'Bearer '+token}});
  if(!response.ok)throw Error('API cinéma indisponible ('+response.status+'). Vérifie la configuration du Worker ou ta session Firebase.');
  const data=await response.json();
  if(user!==owner)throw Error('Session modifiée');
  return data;
 })().finally(()=>{if(pendingRequests.get(path)===job)pendingRequests.delete(path)});
 pendingRequests.set(path,job);
 return job;
}
let sagaQuery='',sagaMatches=[],sagaSearching=false,sagaSelected='all',sagaMode='tmdb',sagaCreateOpen=false,sagaSearchTimer=null,sagaSearchSeq=0,sagaMovieQuery='',sagaMovieMatches=[],sagaMovieSeq=0,sagaMovieTimer=null;const sagaCache=new Map();let listPickerOpen=false,listEditId=null,listTabMedia='films',listSelected='all',listQuery='',listView='cards',listModalSource=null;
const pendingSagaMovies=new Map();
const sagaMovieIds=(s,key=s.id)=>[...new Set([
 ...(sagaCache.get(s.tmdbId)?.parts||[]).map(movie=>movie.id),
 ...(s.movieIds||[]),
 ...(pendingSagaMovies.get(key)||[]),
].map(Number))];
const sagaSeriesIds=s=>[...new Set((s.tvIds||[]).map(Number))];
const sagaContains=(s,id,kind='movie')=>(kind==='tv'?sagaSeriesIds(s):sagaMovieIds(s)).includes(Number(id));
const savedSagas=()=>Object.entries(state.sagas||{}).map(([id,saga])=>({id,...saga})).sort((a,b)=>a.name.localeCompare(b.name,'fr'));
function hydrateSagas(){
 const sagas=savedSagas();
 const missingCollections=[...new Set(sagas.map(s=>s.tmdbId).filter(id=>id&&!sagaCache.has(id)))];
 const missingItems=[
  ...sagas.flatMap(s=>s.movieIds||[]).map(id=>'movie:'+Number(id)),
  ...sagas.flatMap(sagaSeriesIds).map(id=>'tv:'+id),
 ].filter(resource=>{
  const [kind,value]=resource.split(':'),id=Number(value);
  return Number.isSafeInteger(id)&&id>0&&!(kind==='tv'?seriesCache:filmCache).has(id);
 });
 const resources=[...new Set(missingItems)];
 if(!missingCollections.length&&!resources.length)return;
 const owner=user;
 const isActive=()=>user===owner&&tab==='collections'&&!selected&&!film&&!seriesId;
 return loadSection('collections',async()=>{
  for(let i=0;i<missingCollections.length&&isActive();i+=5){
   await Promise.allSettled(missingCollections.slice(i,i+5).map(async id=>{
    if(sagaCache.has(id))return;
    const data=await request('/api/collections/'+id);
    sagaCache.set(id,data);
    for(const movie of data.parts||[])if(!filmCache.has(movie.id))filmCache.set(movie.id,movie);
   }));
  }
  for(let i=0;i<resources.length&&isActive();i+=5){
   await Promise.allSettled(resources.slice(i,i+5).map(async resource=>{
    const [kind,value]=resource.split(':'),id=Number(value);
    const cache=kind==='tv'?seriesCache:filmCache;
    if(!cache.has(id))cache.set(id,await request('/api/'+kind+'/'+id));
   }));
  }
 },[...missingCollections.map(id=>'collection:'+id),...resources]);
}

async function readSagaCover(file){
 if(!file)return '';
 if(!file.type.startsWith('image/'))throw Error('Sélectionne un fichier image.');
 if(file.size>12*1024*1024)throw Error('Image trop volumineuse (12 Mo maximum).');
 const bitmap=await createImageBitmap(file);
 try{
  const ratio=Math.min(1,540/bitmap.width,810/bitmap.height),canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
  canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
  const result=canvas.toDataURL('image/jpeg',.72);
  if(result.length>250000)throw Error('Image trop volumineuse après compression. Essaie une image plus petite.');
  return result;
 }finally{bitmap.close()}
}
document.addEventListener('change',async e=>{
 if(e.target.id!=='sagaCoverFile'||!e.target.files?.[0])return;
 const saga=state.sagas?.[sagaSelected];if(!saga)return;
 try{saga.coverUrl=await readSagaCover(e.target.files[0]);await persist();render()}
 catch(err){error=err.message;render()}
});
function sagaProgressMarkup(seen,total){
 const percent=total?Math.round(seen/total*100):0;
 return '<span class="mq-saga-progress" role="progressbar" aria-label="Films vus dans la collection" aria-valuenow="'+percent+'" aria-valuetext="'+seen+' sur '+total+' films vus"><span style="width:'+percent+'%"></span></span>';
}
function sagaMovieResultsMarkup(ids){
 const included=new Set(ids);
 return sagaMovieMatches.map(movie=>{
  const present=included.has(Number(movie.id));
  return '<button type="button" data-saga-movie-pick="'+movie.id+'" aria-label="'+
   esc((present?'Déjà dans la collection : ':'Ajouter à la collection : ')+movie.title)+'"'+(present?' aria-disabled="true"':'')+'>'+
   (movie.poster_path?'<img src="'+poster(movie.poster_path,'w92')+'" loading="lazy" alt="">':'')+
   '<span>'+esc(movie.title)+' ('+esc(movie.release_date?.slice(0,4)||'—')+')</span>'+
   '<span class="mq-saga-movie-action">'+(present?ico('check')+' Déjà ajouté':'Ajouter +')+'</span></button>';
 }).join('');
}
async function addSagaMovie(movie){
 const owner=user,key=sagaSelected,saga=state.sagas?.[key],id=Number(movie.id);
 if(!owner||!saga||!Number.isSafeInteger(id)||id<=0||sagaMovieIds(saga,key).includes(id))return;
 const pending=pendingSagaMovies.get(key)||new Set();
 pending.add(id);
 pendingSagaMovies.set(key,pending);
 if(!filmCache.has(id))filmCache.set(id,movie);
 error='';
 render();
 try{
  await updateDoc(doc(db,'users',owner.uid,'data','movieQuest'),new FieldPath('sagas',key,'movieIds'),arrayUnion(id));
  const current=state.sagas?.[key];
  if(user===owner&&current&&!current.movieIds?.some(value=>Number(value)===id)){
   current.movieIds=[...(current.movieIds||[]),id];
  }
 }catch(e){if(user===owner)error='Impossible d’ajouter le film à la collection. '+e.message}
 finally{
  pending.delete(id);
  if(!pending.size&&pendingSagaMovies.get(key)===pending)pendingSagaMovies.delete(key);
  if(user===owner&&tab==='collections'&&sagaSelected===key)render();
 }
}
async function searchSagaMovies(query,seq){
 try{
  const data=await request('/api/search?q='+encodeURIComponent(query)+'&type=movie');
  if(seq!==sagaMovieSeq)return;
  sagaMovieMatches=(data.results||[]).filter(movie=>movie.role==='movie');
  const collection=state.sagas?.[sagaSelected];
  const box=document.getElementById('sagaMovieMatches');
  if(box&&collection)box.innerHTML=sagaMovieResultsMarkup(sagaMovieIds(collection,sagaSelected));
 }catch(e){
  if(seq!==sagaMovieSeq)return;
  const box=document.getElementById('sagaMovieMatches');
  if(box)box.textContent=e.message;
 }
}
function sagaSeriesProgress(ids){
 if(!ids.length)return '';
 const seen=ids.filter(id=>seriesState(id).status==='seen').length;
 return seen+' / '+ids.length+(ids.length===1?' série vue':' séries vues');
}
function sagaMarkup(){
 const sagas=savedSagas(),chosen=sagas.find(s=>s.id===sagaSelected),data=chosen?.tmdbId?sagaCache.get(chosen.tmdbId):null;
 const ids=chosen?sagaMovieIds(chosen):[],tvIds=chosen?sagaSeriesIds(chosen):[];
 const shows=tvIds.map(id=>seriesCache.get(id)).filter(Boolean)
  .sort((a,b)=>(b.first_air_date||'').localeCompare(a.first_air_date||''));
 const seriesProgress=sagaSeriesProgress(tvIds);
 const movies=ids.map(id=>filmCache.get(id)||data?.parts?.find(movie=>movie.id===id)).filter(Boolean)
  .sort((a,b)=>(b.release_date||'').localeCompare(a.release_date||''));
 const seen=ids.filter(id=>state.statuses[id]==='seen').length;
 const loadingCollections=sectionLoads.has('collections');
 const coverCandidates=chosen?[...new Set([chosen.poster_path,data?.poster_path,...movies.map(m=>m.poster_path),...shows.map(show=>show.poster_path)].filter(Boolean))].slice(0,16):[];
 const activeCover=chosen?.coverUrl||chosen?.poster_path||data?.poster_path||movies.find(m=>m.poster_path)?.poster_path||shows.find(show=>show.poster_path)?.poster_path;
 const cards=sagas.map(s=>{
  const details=s.tmdbId?sagaCache.get(s.tmdbId):null;
  const ids=sagaMovieIds(s),tvIds=sagaSeriesIds(s);
  const films=ids.map(id=>filmCache.get(id)||details?.parts?.find(movie=>movie.id===id)).filter(Boolean);
  const watched=ids.filter(id=>state.statuses[id]==='seen').length;
  const cover=s.coverUrl||s.poster_path||details?.poster_path||films.find(m=>m.poster_path)?.poster_path||tvIds.map(id=>seriesCache.get(id)?.poster_path).find(Boolean);
  return '<button type="button" class="mq-saga-card" data-saga-select="'+esc(s.id)+'"><span class="mq-saga-cover">'+(cover?mediaImage(s.coverUrl?cover:poster(cover),'collection',{lazy:true}):''+placeholder('collection')+'')+'</span><span class="mq-saga-card-info"><strong>'+esc(s.name)+'</strong><small>'+(loadingCollections&&!ids.length?'Chargement…':watched+' / '+ids.length+' films vus')+'</small>'+(tvIds.length?'<small>'+sagaSeriesProgress(tvIds)+'</small>':'')+sagaProgressMarkup(watched,ids.length)+'</span></button>';
 }).join('');
 return '<section class="mq-saga-section"><div class="mq-library-section-heading"><h2>Collections</h2><p>Explore tes franchises et suis ta progression film par film.</p></div>'+
 (chosen?'<div class="mq-saga-detail"><div class="mq-saga-hero"><div class="mq-saga-hero-art">'+(activeCover?mediaImage(chosen.coverUrl?activeCover:poster(activeCover,'w500'),'collection',{alt:'Couverture de '+chosen.name}):placeholder('collection'))+'</div><div class="mq-saga-heading"><div class="mq-saga-summary"><button type="button" class="mq-saga-back" data-saga-select="all">← Toutes les collections</button><h3>'+esc(chosen.name)+'</h3><p class="muted">'+seen+' / '+ids.length+' films vus'+(chosen.tmdbId?' · Collection TMDB personnalisable':' · Collection personnalisée')+'</p>'+sagaProgressMarkup(seen,ids.length)+(seriesProgress?'<p class="muted">'+seriesProgress+'</p>':'')+'</div><div class="mq-saga-top-actions"><label class="mq-saga-upload" for="sagaCoverFile"><svg class="mq-saga-image-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m4 18 5-5 3.5 3.5 3-3L21 19"/></svg> Importer une couverture<input id="sagaCoverFile" type="file" accept="image/*"></label><button type="button" data-saga-rename="'+esc(chosen.id)+'">Renommer</button><button type="button" data-saga-delete="'+esc(chosen.id)+'">Supprimer</button></div></div></div><div class="mq-saga-cover-gallery"><h4>Choisir une couverture</h4><div class="mq-saga-cover-options">'+coverCandidates.map(path=>'<button type="button" data-saga-cover-pick="'+esc(path)+'" aria-label="Utiliser cette affiche comme couverture"><img src="'+poster(path,'w185')+'" alt=""></button>').join('')+'</div></div><div class="mq-saga-editor"><label for="sagaMovieSearch">Ajouter un film à la collection</label><div class="mq-saga-search-field"><input id="sagaMovieSearch" autocomplete="off" placeholder="Rechercher un film par son titre…" value="'+esc(sagaMovieQuery)+'"><button type="button" data-saga-search-clear aria-label="Effacer la recherche" '+(sagaMovieQuery?'':'hidden')+'>×</button></div><div id="sagaMovieMatches" class="mq-saga-matches">'+sagaMovieResultsMarkup(ids)+'</div></div>'+loadingContent(loadingCollections,'Chargement des films de la collection…',filmList(movies,listView),movies.length,listView)+(tvIds.length?'<section><h4>Séries</h4>'+
 loadingContent(loadingCollections,'Chargement des séries de la collection…',seriesList(shows,listView),shows.length,listView)+'</section>':'')+'</div>':
 '<div class="mq-saga-create"><label for="sagaSearch">Rechercher une collection TMDB</label><div class="mq-saga-search"><input id="sagaSearch" autocomplete="off" placeholder="Star Wars, Retour vers le futur, Batman…" value="'+esc(sagaQuery)+'"><button type="button" data-saga-create>+ Collection personnalisée</button></div>'+
 '<div id="sagaSearchFeedback">'+loadingContent(sagaSearching,'Recherche de collections…','',true)+
 (sagaMatches.length?'<div class="mq-saga-matches">'+sagaMatches.map(s=>'<button type="button" data-saga-add="'+s.id+'">'+(s.poster_path?'<img src="'+poster(s.poster_path,'w92')+'" alt="">':'')+'<span>'+esc(s.name)+'</span><span>Ajouter +</span></button>').join('')+'</div>':'')+'</div></div>'+
 loadingContent(loadingCollections,'Chargement des collections…',sagas.length?'<div class="mq-saga-cards">'+cards+'</div>':'<div class="empty">Aucune collection enregistrée. Recherche une franchise ou crée ta propre collection.</div>',sagas.length,'cards'))+
 (sagaCreateOpen?'<div class="mq-list-modal-backdrop" data-saga-modal-backdrop><section class="mq-list-modal mq-saga-create-modal" role="dialog" aria-modal="true" aria-labelledby="sagaModalTitle"><div class="mq-list-modal-head"><h2 id="sagaModalTitle">Nouvelle collection</h2><button type="button" class="icon-only" data-saga-modal-close aria-label="Fermer">×</button></div><form id="sagaCreateForm" class="mq-saga-create-form"><label for="sagaNameInput">Nom de la collection</label><input id="sagaNameInput" name="name" maxlength="80" required placeholder="Ex. Marvel, Batman, Studio Ghibli…" autofocus><label for="sagaCreateCover">Image de couverture (facultative)</label><input id="sagaCreateCover" name="cover" type="file" accept="image/*"><div class="mq-saga-modal-actions"><button type="button" data-saga-modal-close>Annuler</button><button type="submit">Créer la collection</button></div></form></section></div>':'')+'</section>';
}
async function searchSagaCollections(){
 const q=sagaQuery.trim(),seq=++sagaSearchSeq;
 if(!q){sagaMatches=[];sagaSearching=false;document.getElementById('sagaSearchFeedback')?.replaceChildren();return}
 sagaSearching=true;
 const feedback=document.getElementById('sagaSearchFeedback');
 if(feedback)feedback.innerHTML=loadingContent(true,'Recherche de collections…','',true);
 try{
  const result=await request('/api/collections/search?q='+encodeURIComponent(q));
  if(seq!==sagaSearchSeq)return;
  sagaMatches=result.results||[];
  const target=document.getElementById('sagaSearchFeedback');
  if(target)target.innerHTML=sagaMatches.length?'<div class="mq-saga-matches">'+sagaMatches.map(s=>'<button type="button" data-saga-add="'+s.id+'">'+(s.poster_path?'<img src="'+poster(s.poster_path,'w92')+'" alt="">':'')+'<span>'+esc(s.name)+'</span><span>Ajouter +</span></button>').join('')+'</div>':'<p class="muted">Aucune collection trouvée.</p>';
 }catch(err){if(seq===sagaSearchSeq){const target=document.getElementById('sagaSearchFeedback');if(target)target.textContent='Recherche indisponible : '+err.message}}
 finally{if(seq===sagaSearchSeq)sagaSearching=false}
}
const sortedLists=()=>Object.entries(state.lists||{}).sort((a,b)=>(a[1].order??0)-(b[1].order??0)).map(([id,data])=>({id,...data}));
const listsFor=(id,kind='movie')=>sortedLists().filter(list=>(list[kind==='tv'?'tvIds':'movieIds']||[]).some(value=>Number(value)===Number(id)));
const listLabels=(id,kind='movie')=>{
 const names=[...listsFor(id,kind),...savedSagas().filter(saga=>sagaContains(saga,id,kind))];
 return names.length?'<div class="mq-list-labels">'+names.map(item=>'<span class="mq-list-label">'+esc(item.name)+'</span>').join('')+'</div>':'';
};
const listButton=(id,kind='movie')=>'<button class="icon-only mq-list-add '+(listsFor(id,kind).length?'chosen mq-in-list':'')+'" type="button" data-open-list-modal="'+id+'" data-list-kind="'+kind+'" title="'+(listsFor(id,kind).length?'Gérer les listes associées':'Ajouter à une liste')+'" aria-label="Gérer les listes">'+ico('collection')+'</button>';
// Shared illustration geometry keeps all missing-image states visually consistent.
const placeholderSVG=kind=>{
 const labels={movie:'Affiche indisponible',collection:'Couverture indisponible',person:'Portrait indisponible'};
 const artwork={
 movie:'<circle cx="80" cy="98" r="43" fill="currentColor" fill-opacity=".08"/><circle cx="80" cy="98" r="43"/><circle cx="80" cy="98" r="7"/><g fill="currentColor" fill-opacity=".16"><circle cx="80" cy="72" r="10"/><circle cx="105" cy="90" r="10"/><circle cx="95" cy="119" r="10"/><circle cx="65" cy="119" r="10"/><circle cx="55" cy="90" r="10"/></g><path d="M80 141h27c15 0 23 8 23 19s-8 18-20 18H47"/><path d="M52 170v8m14-8v8m14-8v8" opacity=".45"/>',
 collection:'<path d="M42 63V49a6 6 0 0 1 6-6h64a6 6 0 0 1 6 6v14" opacity=".35"/><path d="M33 80V66a6 6 0 0 1 6-6h82a6 6 0 0 1 6 6v14" opacity=".6"/><rect x="24" y="77" width="112" height="91" rx="10" fill="currentColor" fill-opacity=".08"/><rect x="24" y="77" width="112" height="91" rx="10"/><path d="m73 106 24 16-24 16z" fill="currentColor" fill-opacity=".16"/><path d="M36 91h6m-6 14h6m-6 14h6m-6 14h6m-6 14h6m76-56h6m-6 14h6m-6 14h6m-6 14h6m-6 14h6" opacity=".45"/>',
 person:'<circle cx="80" cy="81" r="27" fill="currentColor" fill-opacity=".08"/><circle cx="80" cy="81" r="27"/><path d="M34 165v-9c0-24 20-42 46-42s46 18 46 42v9z" fill="currentColor" fill-opacity=".08"/><path d="M34 165v-9c0-24 20-42 46-42s46 18 46 42v9z"/><path d="M64 126c5 8 10 11 16 11s11-3 16-11" opacity=".45"/>'
 };
 return '<svg class="mq-placeholder-icon" viewBox="0 0 160 220" role="img" aria-label="'+(labels[kind]||labels.movie)+'" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="80" cy="108" r="67" fill="currentColor" fill-opacity=".025" stroke-opacity=".1"/><path d="M21 47h12m-6-6v12m103 124h10m-5-5v10" stroke-width="2" opacity=".4"/>'+(artwork[kind]||artwork.movie)+'<path d="M66 202h28" opacity=".3"/></svg>';
};
const placeholder=kind=>'<span class="mq-placeholder mq-placeholder-'+kind+'">'+placeholderSVG(kind)+'</span>';
function mediaImage(src,kind,{alt='',lazy=false,className=''}={}){
 return '<span class="mq-media-frame '+className+'" data-media-state="pending">'+
  '<img data-media-kind="'+kind+'" src="'+esc(src)+'" alt="'+esc(alt)+'" decoding="async"'+(lazy?' loading="lazy"':'')+'>'+
  '<span class="mq-media-loader" aria-hidden="true">'+loadingDots()+'</span></span>';
}

function settleMediaImage(event){
 const image=event.target;
 if(!image.dataset?.mediaKind)return;
 const frame=image.parentElement;
 if(frame?.dataset.mediaState!=='pending')return;
 frame.dataset.mediaState=event.type==='load'?'ready':'failed';
 if(event.type==='error'){
  image.hidden=true;
  frame.insertAdjacentHTML('beforeend',placeholder(image.dataset.mediaKind));
 }
}
el.addEventListener('load',settleMediaImage,true);
el.addEventListener('error',settleMediaImage,true);

function responsiveDescription(content,label){const value=esc(content||'Texte indisponible.');return '<div class="mq-description-desktop"><p>'+value+'</p></div><details class="mq-description-mobile"><summary>'+esc(label)+' <span>Afficher la suite ···</span></summary><p>'+value+'</p></details>'}
function listPickerMarkup(id,kind='movie'){return '<div class="mq-film-lists">'+listLabels(id,kind)+'<button class="mq-list-trigger" type="button" data-open-list-modal="'+id+'" data-list-kind="'+kind+'">'+ico('plus')+' Gérer les listes</button></div>'}
const listModalIcon=name=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+({close:'<path d="m6 6 12 12M18 6 6 18"/>',edit:'<path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15z"/>',grip:'<path d="M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01" stroke-width="3.5"/>'}[name]||'')+'</svg>';
function listModalMarkup(){
 if(!listModalSource)return '';
 const {id,kind}=listModalSource,lists=sortedLists(),sagas=savedSagas();
 const check=checked=>'<span class="mq-check-box" aria-hidden="true">'+(checked?ico('check'):'')+'</span>';
 const rows=lists.map(l=>{
  const checked=(l[kind==='tv'?'tvIds':'movieIds']||[]).some(value=>Number(value)===Number(id));
  const count=(l.movieIds||[]).length+(l.tvIds||[]).length;
  return '<div class="mq-list-modal-row" draggable="true" data-drag-list="'+esc(l.id)+'"><span class="mq-drag-handle" title="Glisser pour réorganiser" aria-hidden="true">'+listModalIcon('grip')+'</span><button type="button" class="mq-list-choice" role="checkbox" aria-checked="'+checked+'" data-toggle-movie-list="'+esc(l.id)+'" data-movie-id="'+id+'" data-list-kind="'+kind+'">'+check(checked)+'<span class="mq-list-label-text"><strong>'+esc(l.name)+'</strong><small>'+count+' contenu'+(count===1?'':'s')+'</small></span></button><div class="mq-list-row-actions"><button type="button" class="icon-only" data-edit-list="'+esc(l.id)+'" title="Renommer" aria-label="Renommer la liste '+esc(l.name)+'">'+listModalIcon('edit')+'</button><button type="button" class="icon-only mq-list-delete" data-delete-list="'+esc(l.id)+'" title="Supprimer" aria-label="Supprimer la liste '+esc(l.name)+'">'+listModalIcon('close')+'</button></div></div>';
 }).join('');
 const collectionRows=sagas.map(s=>{
  const checked=sagaContains(s,id,kind),tvCount=sagaSeriesIds(s).length,count=sagaMovieIds(s).length+tvCount;
  const countLabel=(kind==='tv'||tvCount)?' contenu':' film';
  return '<div class="mq-list-modal-row"><button type="button" class="mq-list-choice" role="checkbox" aria-checked="'+checked+'" data-toggle-movie-saga="'+esc(s.id)+'" data-movie-id="'+id+'" data-list-kind="'+kind+'">'+check(checked)+'<span class="mq-list-label-text"><strong>'+esc(s.name)+'</strong><small>'+count+countLabel+(count===1?'':'s')+'</small></span></button></div>';
 }).join('');
 return '<div class="mq-list-modal-backdrop" data-list-modal-backdrop><section class="mq-list-modal mq-list-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="mqListModalTitle" aria-describedby="mqListModalDescription"><div class="mq-list-modal-head"><div><h2 id="mqListModalTitle">Listes et collections</h2><p id="mqListModalDescription">Choisis où retrouver '+(kind==='tv'?'cette série':'ce film')+'. Tu peux faire plusieurs sélections.</p></div><button type="button" class="icon-only" data-close-list-modal aria-label="Fermer">'+listModalIcon('close')+'</button></div><div class="mq-list-modal-body"><div class="mq-list-section-heading"><h3>Mes listes</h3><span>'+lists.length+'</span></div>'+(lists.length?'<p class="mq-list-section-hint">Glisse les lignes pour réorganiser tes listes.</p><div class="mq-list-modal-rows">'+rows+'</div>':'<p class="mq-list-modal-empty">Crée ta première liste pour organiser tes films et séries.</p>')+(listEditId?'<form class="mq-list-create" id="mqListNameForm"><label for="listNameInput">'+(listEditId==='new'?'Nouvelle liste':'Renommer la liste')+'</label><input id="listNameInput" maxlength="60" required placeholder="Ex. Soirées cinéma" value="'+esc(listEditId==='new'?'':state.lists?.[listEditId]?.name||'')+'"><div class="mq-list-form-actions"><button type="button" data-cancel-list>Annuler</button><button type="submit">Enregistrer</button></div></form>':'<button type="button" class="mq-list-new" data-new-list>'+ico('plus')+' Nouvelle liste</button>')+'<div class="mq-list-section-heading mq-collection-section-heading"><h3>Mes collections</h3><span>'+sagas.length+'</span></div>'+(sagas.length?'<div class="mq-list-modal-rows">'+collectionRows+'</div>':'<p class="mq-list-modal-empty">Tes collections apparaîtront ici une fois créées dans Bibliothèque › Collections.</p>')+'</div><div class="mq-list-modal-foot"><span>Les sélections sont enregistrées automatiquement.</span><button type="button" data-close-list-modal>Terminer</button></div></section></div>';
}
const seriesMembershipWrites=new Set();
async function toggleSeriesMembership(group,key,id){
 const owner=user,item=state[group]?.[key];
 if(!owner||!item||!Number.isSafeInteger(id)||id<=0)return;
 const operation=JSON.stringify([owner.uid,group,key,id]);
 if(seriesMembershipWrites.has(operation))return;
 const included=(item.tvIds||[]).some(value=>Number(value)===id);
 seriesMembershipWrites.add(operation);
 try{
  await updateDoc(doc(db,'users',owner.uid,'data','movieQuest'),new FieldPath(group,key,'tvIds'),
   included?arrayRemove(id,String(id)):arrayUnion(id));
 }finally{seriesMembershipWrites.delete(operation)}
}
function closeListModal(){
 const source=listModalSource;listModalSource=null;listEditId=null;render();
 if(source)document.querySelector('[data-open-list-modal="'+source.id+'"][data-list-kind="'+source.kind+'"]')?.focus();
}
document.addEventListener('keydown',e=>{
 if(!listModalSource||document.querySelector('.mq-confirm-dialog[open]'))return;
 if(e.key==='Escape'){e.preventDefault();closeListModal();return}
 if(e.key!=='Tab')return;
 const modal=document.querySelector('.mq-list-picker-dialog');
 const controls=[...(modal?.querySelectorAll('button:not(:disabled),input:not(:disabled)')||[])].filter(node=>node.getClientRects().length);
 if(!controls.length)return;
 const first=controls[0],last=controls[controls.length-1];
 if(!modal.contains(document.activeElement)){e.preventDefault();first.focus()}
 else if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
 else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
});

function listCollectionMarkup(){const all=sortedLists(),chosen=all.find(l=>l.id===listSelected),ids=chosen?[...(chosen.movieIds||[])]:[...new Set(all.flatMap(l=>l.movieIds||[]))],tvIds=chosen?[...(chosen.tvIds||[])]:[...new Set(all.flatMap(l=>l.tvIds||[]))],movies=ids.map(id=>filmCache.get(Number(id))).filter(Boolean).filter(m=>matchesMovieTab(m,listTabMedia)&&matchesText(m.title,listQuery)&&passesExtraFilters(m)&&(!m.release_date||(Number(m.release_date.slice(0,4))>=suggestionMinYear&&Number(m.release_date.slice(0,4))<=suggestionMaxYear))&&(!suggestionGenres.length||suggestionGenres.some(g=>(m.genre_ids||m.genres?.map(x=>x.id)||[]).includes(Number(g))))),series=tvIds.map(id=>seriesCache.get(Number(id))||followedSeries().find(m=>m.id===Number(id))).filter(Boolean).filter(m=>matchesText(m.name,listQuery));return '<div class="mq-library-section-heading"><h2>Mes listes</h2><p>Organise tes films, séries, documentaires et spectacles dans des listes personnelles.</p></div><div class="mq-list-browser"><aside class="mq-list-sidebar"><button class="'+(listSelected==='all'?'active':'')+'" data-select-list="all">Toutes mes listes</button>'+all.map(l=>'<button class="'+(listSelected===l.id?'active':'')+'" data-select-list="'+esc(l.id)+'">'+esc(l.name)+' <small>'+((l.movieIds||[]).length+(l.tvIds||[]).length)+'</small></button>').join('')+'<button class="mq-list-sidebar-add" data-open-list-modal="0" data-list-kind="movie">'+ico('plus')+' Gérer les listes</button></aside><section class="mq-list-browser-main"><h3>'+esc(chosen?.name||'Tous les contenus')+'</h3>'+mediaTabs('list-media',listTabMedia,[['films','Films'],['series','Séries'],['documentaries','Documentaires'],['spectacles','Spectacles']])+filterBar({id:'listSearch',queryValue:listQuery,placeholder:'Rechercher dans mes listes…',field:'list-view',mode:listView,extra:filterTrigger()})+'<div id="listResults">'+loadingContent(sectionLoads.has('lists'),'Chargement des listes…',listTabMedia==='series'?seriesList(series,listView):filmList(movies,listView),listTabMedia==='series'?series.length:movies.length,listView)+'</div>'+suggestionFilterDialog()+'</section></div>'}
async function persist(){if(!user)return;try{await setDoc(doc(db,'users',user.uid,'data','movieQuest'),state)}catch(e){error='Firestore : '+e.message;render()}}
async function follow(p){if(!user)return;if(state.following[p.id]&&!await confirmAction('Ne plus suivre '+p.name+' ?','Cette personnalité sera retirée de ta collection.','Ne plus suivre'))return;const wasFollowing=!!state.following[p.id];if(wasFollowing)delete state.following[p.id];else state.following[p.id]={id:p.id,name:p.name,role:p.role,profile_path:p.profile_path||null};followedCredits=null;if(tab==='explore'&&!selected&&!film)updateFollowControls(p.id);else if(selected===p.id){const control=document.querySelector('[data-follow="'+p.id+'"]');if(control)updateFollowControls(p.id);else render()}else render();await persist();if(!wasFollowing&&needsFollowing('movies'))await loadFollowing('movies');render()}
function updateFollowControls(id){document.querySelectorAll('[data-follow="'+id+'"]').forEach(button=>{const active=!!state.following[id];button.classList.toggle('chosen',active);button.setAttribute('aria-label',active?'Ne plus suivre':'Suivre');button.title=active?'Ne plus suivre':'Suivre';button.innerHTML=ico(active?'check':'plus')})}
async function changeStatus(id,value){if(!user)return;if(value==='todo'&&!filmCache.has(Number(id))){try{filmCache.set(Number(id),await request('/api/movie/'+id))}catch(e){console.warn('Unable to cache movie',e)}}if(value==='todo'){state.statuses[id]='todo';delete state.seenAt[id]}else if(value==='none'){state.statuses[id]='none';delete state.seenAt[id]}else{state.statuses[id]=value;if(value==='seen'&&!state.seenAt[id])state.seenAt[id]=new Date().toISOString();if(value!=='seen')delete state.seenAt[id]}await persist();render()}
function confirmAction(title,message,confirmLabel){return new Promise(resolve=>{const dialog=document.createElement('dialog');dialog.className='mq-confirm-dialog';dialog.innerHTML='<form method="dialog"><h2>'+esc(title)+'</h2><p>'+esc(message)+'</p><div class="confirm-actions"><button type="submit" value="cancel">Annuler</button><button class="confirm-danger" type="submit" value="confirm">'+esc(confirmLabel)+'</button></div></form>';document.body.append(dialog);dialog.addEventListener('close',()=>{const ok=dialog.returnValue==='confirm';dialog.remove();resolve(ok)},{once:true});dialog.showModal()})}
async function dismiss(id){state.dismissed[id]=new Date().toISOString();await persist();render()}
function loadPerson(p){
 if(people.has(p.id))return;
 if(personRequests.has(p.id))return personRequests.get(p.id);
 const owner=user;
 const job=(async()=>{
  try{
   const data=await request('/api/person/'+p.id+'/movies?role='+encodeURIComponent(p.role||'actor'));
   people.set(p.id,data);
   followedCredits=null;
   for(const movie of data.movies||[])if(!filmCache.get(movie.id)?.credits)filmCache.set(movie.id,movie);
   const old=state.following[p.id],profile=data.profile||{};
   if(old&&profile.name){
    const name=(!old.name||old.name==='Personnalité')?profile.name:old.name;
    const photo=old.profile_path||profile.profile_path||null;
    if(name!==old.name||photo!==old.profile_path){
     state.following[p.id]={...old,name,profile_path:photo};
     persist();
    }
   }
  }catch(e){if(user===owner&&selected===p.id)error=e.message}
  finally{
   if(personRequests.get(p.id)===job)personRequests.delete(p.id);
   if(user===owner&&selected===p.id)render();
  }
 })();
 personRequests.set(p.id,job);
 if(selected===p.id)render();
 return job;
}
function loadFollowing(media){
 const series=media==='series';
 const cache=series?personSeriesCache:people;
 const items=followed().filter(person=>!cache.has(person.id));
 if(!items.length)return;
 const owner=user;
 return loadSection(followingLoadKey(media),async()=>{
  for(let i=0;i<items.length&&user===owner&&needsFollowing(media);i+=4){
   await Promise.allSettled(items.slice(i,i+4).filter(person=>state.following[person.id]).map(person=>series?loadPersonSeries(person.id):loadPerson(person)));
  }
 },items.map(p=>p.id));
}
let timer;
async function search(){
 const seq=++searchSeq;
 if(!query.trim()){results=[];loading=false;updateSearchResults();return}
 loading=true;
 updateSearchResults();
 try{
  const data=await request('/api/search?q='+encodeURIComponent(query.trim())+'&type='+filter);
  if(seq!==searchSeq)return;
  results=data.results||[];
  error='';
 }catch(e){if(seq===searchSeq){results=[];error=e.message}}
 finally{if(seq===searchSeq){loading=false;updateSearchResults()}}
}
function exploreResultsMarkup(){
 if(!query.trim())return '';
 const content=results.length
  ? '<div class="'+(exploreView==='list'?'mq-table':'mq-grid')+'">'+results.map(x=>x.role==='tv'?seriesCard(x,exploreView):x.role==='movie'?filmCard(x,exploreView):personCard(x,exploreView)).join('')+'</div>'
  : error?'':'<div class="empty">Aucun résultat pour cette recherche.</div>';
 return loadingContent(loading,'Recherche en cours…',content,results.length,exploreView);
}
function updateSearchResults(){
 if(tab!=='explore'||selected||film||seriesId)return;
 const switchArea=document.getElementById('exploreViewSwitch');
 if(switchArea)switchArea.innerHTML=modeSwitch('explore-view',exploreView);
 const target=document.getElementById('exploreResults');
 if(target)target.innerHTML=exploreResultsMarkup();
 const status=document.getElementById('searchState');
 if(status)status.textContent=loading?'':error||'';
}

const btn=(text,attrs='',cls='')=>'<button '+attrs+' class="'+cls+'">'+text+'</button>';
const ico=name=>({collection:'<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h1M3 12h1M3 18h1"/></svg>',filter:'<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M7 12h10M10 17h4"/></svg>',plus:'<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',check:'<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',eye:'<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',later:'<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></svg>',skip:'<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/></svg>',cards:'<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',list:'<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6h12M9 12h12M9 18h12M3 6h2M3 12h2M3 18h2"/></svg>'}[name]||'');
const ib=(symbol,attrs,title,active=false)=>'<button class="icon-only '+(active?'chosen':'')+'" type="button" '+attrs+' title="'+title+'" aria-label="'+title+'">'+ico(symbol)+'</button>';
const modeSwitch=(field,mode)=>'<div class="mode-switch">'+ib('cards','data-'+field+'="cards"','Vue cartes',mode==='cards')+ib('list','data-'+field+'="list"','Vue tableau',mode==='list')+'</div>';
function filterBar({id,queryValue='',placeholder='Rechercher…',chips=[],field,mode,extra=''}){const filterButton=extra.includes('suggestion-filter-trigger')?extra.match(/<button class="icon-only suggestion-filter-trigger[^"]*"[\s\S]*?<\/button>/)?.[0]||'':'';return '<div class="following-controls unified-filters">'+filterButton+'<div class="search-field"><input id="'+id+'" type="search" placeholder="'+esc(placeholder)+'" value="'+esc(queryValue)+'" autocomplete="off"><button class="search-clear" type="button" data-clear-filter="'+id+'" aria-label="Effacer la recherche" '+(queryValue?'':'hidden')+'>×</button></div>'+(chips.length?'<div class="filter-chips">'+chips.map(([value,label,active,attr])=>btn(label,'data-'+attr+'="'+value+'"',active?'active':'')).join('')+'</div>':'')+(filterButton?extra.replace(filterButton,''):extra)+modeSwitch(field,mode)+'</div>'}
const matchesText=(value,q)=>String(value||'').toLocaleLowerCase('fr').includes(q.trim().toLocaleLowerCase('fr'));
function queueFilteredItems(q=queueQuery){if(queueMediaTab==='series')return seriesSuggestions().filter(m=>seriesState(m.id).status==='todo'&&matchesText(m.name,q));if(queueMediaTab==='documentaries')return docSuggestions().filter(m=>matchesText(m.title,q));if(queueMediaTab==='spectacles')return queueMovies().filter(m=>isSpectacle(m)&&matchesText(m.title,q));return queueMovies().filter(m=>isFeatureFilm(m)&&passesExtraFilters(m)&&matchesText(m.title,q)&&(!m.release_date||(Number(m.release_date.slice(0,4))>=suggestionMinYear&&Number(m.release_date.slice(0,4))<=suggestionMaxYear))&&(!suggestionGenres.length||suggestionGenres.some(g=>(m.genre_ids||[]).includes(Number(g)))))}
function watchedMovies(){
 const byId=new Map(followedMovieIndex().map(m=>[Number(m.id),m]));
 for(const [id,value] of Object.entries(state.statuses||{})){
  if(value==='seen'&&filmCache.has(Number(id)))byId.set(Number(id),filmCache.get(Number(id)));
 }
 return [...byId.values()].filter(m=>state.statuses[m.id]==='seen'&&matchesMovieTab(m,watchedMediaTab));
}
function watchedItems(){
 if(watchedMediaTab==='series'){
  const byId=new Map(followedSeries().map(m=>[Number(m.id),m]));
  for(const [id,record] of Object.entries(state.series||{})){
   if(record.status==='seen'&&!byId.has(Number(id)))byId.set(Number(id),{id:Number(id),...record.metadata});
  }
  return [...byId.values()]
   .filter(m=>{
    const year=Number((m.first_air_date||'').slice(0,4));
    return seriesState(m.id).status==='seen'&&matchesText(m.name,watchedQuery)&&
     (!releasePeriodIsFiltered()||!year||(year>=suggestionMinYear&&year<=suggestionMaxYear));
   })
   .sort((a,b)=>{
    if(watchedSeriesSort==='recent')return (b.first_air_date||'').localeCompare(a.first_air_date||'');
    if(watchedSeriesSort==='oldest')return (a.first_air_date||'').localeCompare(b.first_air_date||'');
    return String(a.name||'').localeCompare(String(b.name||''),'fr');
   });
 }
 const seenTime=id=>Date.parse(state.seenAt?.[id])||0;
 const hasFilters=filtersAreActive();
 return watchedMovies()
  .filter(m=>hasFilters?matchesMovieFilters(m,watchedQuery):matchesText(m.title,watchedQuery))
  .sort((a,b)=>{
   if(watchedSort==='title')return String(a.title||'').localeCompare(String(b.title||''),'fr');
   const direction=watchedSort==='oldest'?1:-1;
   return direction*(seenTime(a.id)-seenTime(b.id));
  });
}
function watchedToolbar(){
 const series=watchedMediaTab==='series';
 const sort=series?watchedSeriesSort:watchedSort;
 const options=[['recent',series?'Diffusion récente':'Vus récemment'],['oldest',series?'Diffusion ancienne':'Vus anciennement'],['title','Titre A–Z']];
 const select='<select id="watchedSort" aria-label="Trier les contenus vus">'+
  options.map(([value,label])=>'<option value="'+value+'"'+(sort===value?' selected':'')+'>'+label+'</option>').join('')+'</select>';
 return '<div class="mq-watched-toolbar">'+filterBar({
  id:'watchedSearch',queryValue:watchedQuery,placeholder:'Rechercher…',field:'view',mode:view,
  extra:filterTrigger(series?releasePeriodIsFiltered():filtersAreActive())+select,
 })+'</div>';
}
function libraryResultsMarkup(items,key,media,pending,label){
 const card=media==='series'?seriesCard:filmCard;
 const body='<p class="suggestion-count">'+items.length+' résultat'+(items.length===1?'':'s')+'</p>'+
  pagedMedia(items,key,view,item=>card(item,view));
 return loadingContent(pending,label,body,items.length,view);
}

function watchedResultsMarkup(){
 const pending=watchedMediaTab==='series'?followingIsLoading('series'):sectionLoads.has('watched');
 return libraryResultsMarkup(watchedItems(),'watched',watchedMediaTab,pending,'Chargement de tes visionnages…');
}
async function hydrateWatchedMovies(){
 await hydrateSavedMovies(['seen'],'watched');
 if(tab==='watched'&&!selected&&!film&&!seriesId)await hydrateFilterMetadata();
}
function queueResultsMarkup(q=''){
 const pending=followingIsLoading(queueMediaTab)||(queueMediaTab!=='series'&&sectionLoads.has('queue'));
 return libraryResultsMarkup(queueFilteredItems(q),'queue',queueMediaTab,pending,'Chargement des contenus à compléter…');
}

function updateFilterResults(id){const q={personFilmSearch:personFilmQuery,personSeriesSearch:personSeriesQuery,castSearch:castQuery,nowSearch:nowQuery,releaseSearch:releaseQuery,queueSearch:queueQuery,watchedSearch:watchedQuery}[id]||'';const target=document.getElementById(id+'Results');if(!target)return;if(id==='personSeriesSearch'){target.innerHTML=seriesList((personSeriesCache.get(selected)||[]).filter(m=>matchesText(m.name,q)&&(!m.first_air_date||(Number(m.first_air_date.slice(0,4))>=suggestionMinYear&&Number(m.first_air_date.slice(0,4))<=suggestionMaxYear))),view)}else if(id==='personFilmSearch'){const p=state.following[selected]||currentPerson;target.innerHTML=filmList((people.get(selected)?.movies||[]).filter(m=>(matchesMovieTab(m,personMediaTab))&&(personFilmRole==='all'||(m.person_roles||[p?.role||'actor']).includes(personFilmRole))&&matchesText(m.title,q)&&passesExtraFilters(m)))}else if(id==='castSearch'){const actors=(seriesId?(seriesCache.get(seriesId)?.aggregate_credits?.cast||[]).map(p=>({...p,character:p.roles?.[0]?.character||''})):(filmCache.get(film)?.credits?.cast||[])).slice(0,18).filter(p=>matchesText(p.name,q)||matchesText(p.character,q));target.innerHTML=castMarkup(actors)}else if(id==='nowSearch'){mediaPages.upcoming=0;mediaPages.current=0;target.innerHTML=nowPlayingSections(q)}else if(id==='releaseSearch'){mediaPages.release=0;target.innerHTML=releaseMarkup(q)}else if(id==='queueSearch')target.innerHTML=queueResultsMarkup(q);else if(id==='watchedSearch')target.innerHTML=watchedResultsMarkup()}

let onAirSeries=[],onAirLoaded=false;
function loadOnAirSeries(){
 if(onAirLoaded)return;
 return loadSection('on-air',async()=>{
  try{
   const data=await request('/api/tv/on-the-air');
   onAirSeries=data.results||[];
   onAirLoaded=true;
  }catch(e){/* These results are supplementary to followed series. */}
 });
}
function releaseItems(){
 const now=Date.now(),from=now-120*86400000,items=[];
 const owners=followed().filter(p=>(releaseRole==='all'||p.role===releaseRole)&&
  (releasePerson==='all'||matchesText(p.name,releasePerson)));
 const series=releaseMediaTab==='series';
 const credits=new Map();
 for(const person of owners){
  const entries=series?personSeriesCache.get(person.id):people.get(person.id)?.movies;
  for(const item of entries||[])credits.set(item.id,item);
 }
 const aired=series?new Map(onAirSeries.map(item=>[item.id,item])):null;
 for(const [id,credit] of credits){
  const item=series?{...credit,...aired.get(id)}:filmCache.get(id)||credit;
  const date=series?(aired.get(id)?.last_air_date||credit.first_air_date):item.release_date;
  const time=Date.parse(date||'');
  if(time>from&&time<=now&&!state.dismissed[series?'tv:'+id:id])items.push({kind:series?'tv':'movie',date,item});
 }
 return items.sort((a,b)=>b.date.localeCompare(a.date));
}
const librarySearchIds={queue:'queueSearch',watched:'watchedSearch'};
const readLibraryPageSize=()=>2*(Number(getComputedStyle(el).getPropertyValue('--mq-library-columns'))||2);
let libraryPageSize=0;

window.addEventListener('resize',()=>{
 if(!libraryPageSize)return;
 const next=readLibraryPageSize();
 if(next===libraryPageSize)return;
 if(view!=='list'){
  for(const key of Object.keys(librarySearchIds))mediaPages[key]=Math.floor(mediaPages[key]*libraryPageSize/next);
 }
 libraryPageSize=next;
 if(view!=='list'&&librarySearchIds[tab])updateFilterResults(librarySearchIds[tab]);
});

function pagedMedia(items,key,mode,card){
 const library=Object.hasOwn(librarySearchIds,key);
 const size=library&&mode!=='list'?(libraryPageSize||=readLibraryPageSize()):12;
 const pages=Math.max(1,Math.ceil(items.length/size));
 const page=mediaPages[key]=Math.max(0,Math.min(pages-1,mediaPages[key]));
 const visible=items.slice(page*size,(page+1)*size);
 const layout=mode==='list'?'mq-table':library?'mq-grid mq-library-grid':'mq-grid';
 const body=visible.length?'<div class="'+layout+'">'+visible.map(card).join('')+'</div>':'<div class="empty">Aucun résultat à afficher.</div>';
 return body+(pages>1?'<nav class="suggestion-pagination" aria-label="Pagination des résultats"><button type="button" aria-label="Page précédente" data-media-page="'+key+'" data-step="-1" '+(page===0?'disabled':'')+'>←</button><span>Page '+(page+1)+' / '+pages+'</span><button type="button" aria-label="Page suivante" data-media-page="'+key+'" data-step="1" '+(page===pages-1?'disabled':'')+'>→</button></nav>':'');
}
function releaseMarkup(q=releaseQuery){const items=releaseItems().filter(x=>(releaseMediaTab==='series'?x.kind==='tv':x.kind==='movie'&&matchesMovieTab(x.item,releaseMediaTab))&&(x.kind==='tv'||passesExtraFilters(x.item))&&(matchesText(x.item.title||x.item.name,q)||followed().some(p=>matchesText(p.name,q)&&(x.kind==='tv'?(personSeriesCache.get(p.id)||[]).some(m=>m.id===x.item.id):(people.get(p.id)?.movies||[]).some(m=>m.id===x.item.id)))));return loadingContent(followingIsLoading(releaseMediaTab)||(releaseMediaTab==='series'&&sectionLoads.has('on-air')),'Chargement des sorties…',pagedMedia(items,'release',releaseView,x=>x.kind==='tv'?seriesCard(x.item,releaseView):filmCard(x.item,releaseView,true)),items.length,releaseView)}
const seriesState=id=>state.series?.[id]||{status:'todo',episodes:{}};
const seriesRecord=id=>{const m=seriesCache.get(id)||seriesResults.find(x=>x.id===id)||followedSeries().find(x=>x.id===id);return m?{name:m.name,poster_path:m.poster_path||null,first_air_date:m.first_air_date||null}:state.series?.[id]?.metadata||{}};
const seriesSeenCount=id=>Object.values(seriesState(id).episodes||{}).filter(Boolean).length;
const seriesKey=(season,episode)=>season+':'+episode;
const seasonEpisodeKeys=(season,data)=>Array.from({length:data?.episodes?.length||season.episode_count||0},(_,i)=>seriesKey(season.season_number,data?.episodes?.[i]?.episode_number??i+1));
async function changeSeriesStatus(id,value){
 
 if(value==='seen'&&!seriesCache.has(id)){try{await loadSeries(id)}catch(e){return}}const old=seriesState(id),m=seriesCache.get(id),seasons=(m?.seasons||[]).filter(s=>s.season_number>0),episodes={...old.episodes};
 if(value==='seen'){
  for(const season of seasons)for(const key of seasonEpisodeKeys(season,seriesSeasonCache.get(id+':'+season.season_number)))episodes[key]=true;
 }else if(old.status==='seen'&&value==='todo'){
  for(const season of seasons)for(const key of seasonEpisodeKeys(season,seriesSeasonCache.get(id+':'+season.season_number)))delete episodes[key];
 }
 state.series={...(state.series||{}),[id]:{...old,metadata:seriesRecord(id),status:value,episodes}};
 await persist();render()
}
async function changeSeasonStatus(id,number,seen){
 const m=seriesCache.get(id),season=m?.seasons?.find(s=>s.season_number===number);if(!season)return;
 const old=seriesState(id),episodes={...old.episodes},keys=seasonEpisodeKeys(season,seriesSeasonCache.get(id+':'+number));
 for(const key of keys){if(seen)episodes[key]=true;else delete episodes[key]}
 const total=(m.seasons||[]).filter(s=>s.season_number>0).reduce((sum,s)=>sum+(s.episode_count||0),0);
 const watched=Object.values(episodes).filter(Boolean).length;
 state.series={...(state.series||{}),[id]:{...old,metadata:seriesRecord(id),episodes,status:watched>=total&&total>0?'seen':'todo'}};
 await persist();render()
}
async function toggleEpisode(id,season,episode){
 const previous=seriesState(id),key=seriesKey(season,episode),episodes={...previous.episodes,[key]:!previous.episodes?.[key]};
 const m=seriesCache.get(id),total=(m?.seasons||[]).filter(s=>s.season_number>0).reduce((sum,s)=>sum+(s.episode_count||0),0);
 state.series={...(state.series||{}),[id]:{...previous,metadata:seriesRecord(id),status:total&&Object.values(episodes).filter(Boolean).length>=total?'seen':'todo',episodes}};
 await persist();render()
}
async function searchSeries(){const seq=++seriesSearchSeq;if(!seriesQuery.trim()){seriesResults=[];renderSeriesResults();return}try{seriesLoading=true;const data=await request('/api/tv/search?q='+encodeURIComponent(seriesQuery));if(seq!==seriesSearchSeq)return;seriesResults=data.results||[];seriesError=''}catch(e){if(seq===seriesSearchSeq)seriesError=e.message}finally{if(seq===seriesSearchSeq){seriesLoading=false;renderSeriesResults()}}}
async function loadSeries(id){if(seriesCache.has(id))return seriesCache.get(id);seriesError='';try{const data=await request('/api/tv/'+id);seriesCache.set(id,data);if(seriesId===id)render();return data}catch(e){seriesError=e.message;if(seriesId===id)render();throw e}}
const expandedSeasons=new Set();
async function loadSeriesSeason(id,season){const key=id+':'+season;expandedSeasons.add(key);try{if(!seriesSeasonCache.has(key))seriesSeasonCache.set(key,await request('/api/tv/'+id+'/season/'+season));if(seriesId===id)render()}catch(e){expandedSeasons.delete(key);if(seriesId===id){seriesError=e.message;render()}}}
function loadPersonSeries(id){
 if(personSeriesCache.has(id))return;
 return loadSection('person-series:'+id,async()=>{
  try{
   const data=await request('/api/person/'+id+'/tv');
   personSeriesCache.set(id,data.results||[]);
  }catch(e){/* TV credits are optional. */}
 });
}

function seriesCard(m,mode='cards'){const record=seriesState(m.id),seen=seriesSeenCount(m.id);return '<article class="mq-entity mq-movie '+(record.status==='skip'?'mq-ignored ':record.status==='seen'?'mq-related mq-watched ':'')+(mode==='list'?'mq-row':'mq-tile')+'" data-open-tv="'+m.id+'" tabindex="0" role="link" aria-label="Fiche de '+esc(m.name)+'">'+(mode==='list'?'':'<div class="mq-art">'+(m.poster_path?mediaImage(poster(m.poster_path),'movie',{lazy:true}):placeholder('movie'))+'</div>')+'<div class="mq-meta"><h3>'+esc(m.name)+'</h3><small>'+esc((m.first_air_date||'').slice(0,4))+' · Série</small>'+(seen?'<small>'+seen+' épisodes vus</small>':'')+'</div><div class="mq-actions">'+ib(record.status==='seen'?'check':'eye','data-series-status="'+m.id+'" data-value="'+(record.status==='seen'?'todo':'seen')+'"',record.status==='seen'?'Retirer Vu':'Marquer comme vue',record.status==='seen')+ib(record.status==='todo'?'later':'plus','data-series-status="'+m.id+'" data-value="todo"','À voir',record.status==='todo')+listButton(m.id,'tv')+ib('skip','data-series-status="'+m.id+'" data-value="'+(record.status==='skip'?'todo':'skip')+'"','Ignorer',record.status==='skip')+'</div></article>'}
function seriesList(items,mode=seriesView){return items.length?'<div class="'+(mode==='list'?'mq-table':'mq-grid')+'">'+items.map(m=>seriesCard(m,mode)).join('')+'</div>':'<div class="empty">Aucune série à afficher.</div>'}
function followedSeries(){const map=new Map();for(const p of followed())for(const m of personSeriesCache.get(p.id)||[])map.set(m.id,m);return [...map.values()].sort((a,b)=>(b.first_air_date||'').localeCompare(a.first_air_date||''))}
function renderSeriesResults(){if(tab!=='series'||seriesId)return;const target=document.getElementById('seriesResults');if(target)target.innerHTML=seriesQuery.trim()?seriesList(seriesResults):'';const status=document.getElementById('seriesSearchState');if(status)status.textContent=seriesLoading?'Recherche…':seriesError||''}
function seriesHomeMarkup(){const byId=new Map(followedSeries().map(m=>[m.id,m]));for(const [id,record] of Object.entries(state.series||{}))if(record.metadata?.name&&!byId.has(Number(id)))byId.set(Number(id),{id:Number(id),...record.metadata});const personal=[...byId.values()],collection=personal.filter(m=>seriesFilter==='all'||seriesState(m.id).status===seriesFilter);return '<div class="hero"><div class="eyebrow">Movie Quest · TV</div><h1>Séries</h1><p>Retrouve les séries de tes personnalités et suis tes épisodes saison par saison.</p></div><div class="unified-filters"><div class="search-field"><input id="seriesSearch" type="search" placeholder="Rechercher une série…" value="'+esc(seriesQuery)+'" autocomplete="off"><button class="search-clear" data-clear-filter="seriesSearch" type="button" aria-label="Effacer" '+(seriesQuery?'':'hidden')+'>×</button></div><div class="filter-chips">'+[['all','Toutes'],['todo','À voir'],['seen','Vues'],['skip','Ignorées']].map(([v,t])=>btn(t,'data-series-filter="'+v+'"',seriesFilter===v?'active':'')).join('')+'</div>'+modeSwitch('series-view',seriesView)+'</div><p id="seriesSearchState" class="muted">'+esc(seriesError)+'</p><div id="seriesResults">'+(seriesQuery.trim()?seriesList(seriesResults):'')+'</div><section class="series-personal"><h2>Ma collection de séries</h2><p>Les séries de tes personnalités et celles dont tu suis la progression.</p><div id="seriesPersonalResults">'+seriesList(collection)+'</div></section>'}
const tmdbLink=(kind,id)=>Number(id)>0?'<a class="mq-tmdb-link" href="https://www.themoviedb.org/'+kind+'/'+encodeURIComponent(String(id))+'?language=fr-FR" target="_blank" rel="noopener noreferrer" aria-label="Voir cette fiche sur TMDB (nouvel onglet)">Voir sur TMDB ↗</a>':'';
function seriesDetailMarkup(){
 const m=seriesCache.get(seriesId);
 if(!m)return seriesError?'<p class="notice">'+esc(seriesError)+'</p>':loadingContent(true,'Chargement de la série…','',false,'detail');
 const record=seriesState(seriesId),seasons=(m.seasons||[]).filter(s=>s.season_number>0),total=seasons.reduce((n,s)=>n+(s.episode_count||0),0),cast=m.aggregate_credits?.cast||[];
 return '<div class="detail detailtop">'+(m.poster_path?mediaImage(poster(m.poster_path,'w500'),'movie',{className:'mq-detail-media'}):placeholder('movie'))+'<div><div class="eyebrow">Série TV</div><h1>'+esc(m.name)+'</h1>'+tmdbLink('tv',m.id||seriesId)+'<p>'+esc((m.first_air_date||'').slice(0,4))+' · '+seasons.length+' saisons · '+total+' épisodes</p><p>'+esc(m.overview||'Résumé indisponible.')+'</p><p>'+seriesSeenCount(seriesId)+' / '+total+' épisodes vus</p><div class="mq-actions">'+ib(record.status==='seen'?'check':'eye','data-series-status="'+seriesId+'" data-value="'+(record.status==='seen'?'todo':'seen')+'"',record.status==='seen'?'Annuler série vue':'Marquer toute la série comme vue',record.status==='seen')+ib('later','data-series-status="'+seriesId+'" data-value="todo"','À voir',record.status==='todo')+ib('skip','data-series-status="'+seriesId+'" data-value="'+(record.status==='skip'?'todo':'skip')+'"','Ignorer',record.status==='skip')+'</div>'+listPickerMarkup(seriesId,'tv')+'</div></div><section class="series-seasons"><h2>Saisons et épisodes</h2>'+seasons.map(s=>{
 const key=seriesId+':'+s.season_number,data=expandedSeasons.has(key)?seriesSeasonCache.get(key):null,keys=seasonEpisodeKeys(s,data),count=keys.filter(key=>record.episodes?.[key]).length,all=count===keys.length&&keys.length>0;
 return '<div class="series-season"><div class="series-season-toolbar"><button type="button" class="series-season-heading" data-series-season="'+s.season_number+'"><strong>Saison '+s.season_number+'</strong><span>'+count+' / '+s.episode_count+' épisodes · '+(data?'▴':'▾')+'</span></button><div class="mq-actions">'+ib(all?'check':'eye','data-season-status="'+s.season_number+'" data-value="'+(all?'todo':'seen')+'"',all?'Annuler saison vue':'Marquer toute la saison comme vue',all)+'</div></div>'+(data?'<div class="series-episodes">'+(data.episodes||[]).map(e=>{const watched=!!record.episodes?.[seriesKey(s.season_number,e.episode_number)];return '<div class="series-episode '+(watched?'is-watched':'')+'"><span class="episode-number">'+e.episode_number+'</span><div class="episode-meta"><strong>'+esc(e.name||'Épisode '+e.episode_number)+'</strong><small>'+esc(e.air_date||'')+'</small></div><div class="mq-actions">'+ib(watched?'check':'eye','data-series-episode="'+e.episode_number+'" data-season="'+s.season_number+'" data-episode="'+e.episode_number+'"',watched?'Marquer non vu':'Marquer vu',watched)+'</div></div>'}).join('')+'</div>':'')+'</div>'}).join('')+'</section><section class="credits-section"><h2>Distribution</h2>'+filterBar({id:'castSearch',queryValue:castQuery,placeholder:'Rechercher dans la distribution…',field:'cast-view',mode:castView})+'<div id="castSearchResults">'+castMarkup(cast.slice(0,18).map(p=>({...p,character:p.roles?.[0]?.character||''})).filter(p=>matchesText(p.name,castQuery)||matchesText(p.character,castQuery)))+'</div></section>'
}

function castMarkup(actors){for(const p of actors)knownPeople.set(p.id,{id:p.id,name:p.name,role:'actor',profile_path:p.profile_path||null});return actors.length?'<div class="credits-grid '+(castView==='list'?'mq-table':'mq-grid')+'">'+actors.map(p=>{const followedPerson=!!state.following[p.id];return '<article class="credit-person '+(followedPerson?'mq-related ':'')+(castView==='list'?'mq-row':'mq-tile')+'" data-open-person="'+p.id+'" tabindex="0" role="link" aria-label="Fiche de '+esc(p.name)+'">'+(p.profile_path?mediaImage(poster(p.profile_path),'person',{lazy:true}):placeholder('person'))+'<strong>'+esc(p.name)+'</strong><small>'+esc(p.character||'')+'</small><div class="mq-actions">'+ib(followedPerson?'check':'plus','data-cast-follow="'+p.id+'" data-name="'+esc(p.name)+'" data-profile="'+esc(p.profile_path||'')+'"',followedPerson?'Ne plus suivre':'Suivre',followedPerson)+'</div></article>'}).join('')+'</div>':'<div class="empty">Aucune personnalité trouvée.</div>'}
function personCard(p,mode=exploreView){const following=!!state.following[p.id],items=people.get(p.id)?.movies||[];return '<article class="mq-entity mq-person '+(mode==='list'?'mq-row':'mq-tile')+'" data-open-person="'+p.id+'" tabindex="0" role="link" aria-label="Filmographie de '+esc(p.name)+'">'+(mode==='list'?'':'<div class="mq-art">'+(p.profile_path?mediaImage(poster(p.profile_path),'person',{lazy:true}):placeholder('person'))+'</div>')+'<div class="mq-meta"><h3>'+esc(p.name)+'</h3>'+(mode==='list'?'<small>'+(p.role==='director'?'Réalisateur':'Acteur')+'</small>':'')+(items.length?'<small>'+complete(items)+' / '+items.length+' films</small>':'')+'</div><div class="mq-actions">'+ib(following?'check':'plus','data-follow="'+p.id+'"',following?'Ne plus suivre':'Suivre',following)+'</div></article>'}
const personList=(items,mode)=>'<div class="'+(mode==='list'?'mq-table':'mq-grid')+'">'+items.map(p=>personCard(p,mode)).join('')+'</div>';
const directorDetailFailed=new Set(),directorDetailPending=new Set();
function directorPreview(m){const crew=(filmCache.get(Number(m.id))?.credits?.crew||m.credits?.crew||[]).filter(p=>p.job==='Director');const unique=[...new Map(crew.map(p=>[p.id,p])).values()],names=unique.map(p=>p.name).join(', ');return unique.length?'<span class="film-directors mq-director-preview" title="'+esc(names)+'"><button class="credit-link" data-credit-person="'+unique[0].id+'" data-role="director" data-name="'+esc(unique[0].name)+'">'+esc(unique[0].name)+'</button>'+(unique.length>1?'<span class="mq-director-more" title="'+esc(names)+'" aria-label="'+esc(names)+'"> ···</span>':'')+'</span>':'<span class="film-directors mq-director-preview mq-no-director">Réalisateur non renseigné</span>'}
const visibleDirectors=new Set(),observedDirectors=new Set();
function hydrateVisibleDirectors(){
 if(!user)return;
 for(const node of visibleDirectors){
  if(directorDetailPending.size>=3)break;
  if(!node.isConnected)continue;
  const target=node.querySelector('.mq-no-director');
  if(!target)continue;
  const id=Number(node.dataset.openFilm);
  if(!id||directorDetailPending.has(id)||directorDetailFailed.has(id))continue;
  const movie=filmCache.get(id);
  if(movie?.credits){
   if(movie.credits.crew?.some(person=>person.job==='Director'))target.outerHTML=directorPreview(movie);
   else directorDetailFailed.add(id);
   continue;
  }
  const owner=user;
  directorDetailPending.add(id);
  request('/api/movie/'+id).then(data=>{
   filmCache.set(id,{...filmCache.get(id),...data});
   if(!data.credits?.crew?.some(person=>person.job==='Director'))directorDetailFailed.add(id);
  }).catch(()=>{if(user===owner)directorDetailFailed.add(id)}).finally(()=>{
   if(user!==owner)return;
   directorDetailPending.delete(id);
   hydrateVisibleDirectors();
  });
 }
}

if(typeof IntersectionObserver==='function'){
 const directorViewport=new IntersectionObserver(entries=>{
  for(const {target,isIntersecting} of entries){
   if(isIntersecting)visibleDirectors.add(target);
   else visibleDirectors.delete(target);
  }
  hydrateVisibleDirectors();
 },{rootMargin:'80px 0px'});
 const directorObserver=new MutationObserver(()=>{
  for(const node of observedDirectors){
   if(node.isConnected&&node.querySelector('.mq-no-director'))continue;
   directorViewport.unobserve(node);
   observedDirectors.delete(node);
   visibleDirectors.delete(node);
  }
  for(const placeholder of el.querySelectorAll('.mq-movie[data-open-film] .mq-no-director')){
   const node=placeholder.closest('[data-open-film]');
   if(observedDirectors.has(node))continue;
   observedDirectors.add(node);
   directorViewport.observe(node);
  }
 });
 directorObserver.observe(el,{childList:true,subtree:true});
}
const directorLinks=m=>(m.credits?.crew||[]).filter(p=>p.job==='Director').map(p=>'<button class="credit-link" data-credit-person="'+p.id+'" data-role="director" data-name="'+esc(p.name)+'">'+esc(p.name)+'</button>').join(', ');
const movieActions=m=>{const s=status(m.id);return '<div class="mq-actions">'+ib('eye','data-status="'+m.id+'" data-value="'+(s==='seen'?'todo':'seen')+'"',s==='seen'?'Marquer comme à voir':'Marquer comme vu',s==='seen')+ib('later','data-status="'+m.id+'" data-value="'+(s==='todo'?'none':'todo')+'"',s==='todo'?'Retirer de À voir':'Ajouter à À voir',s==='todo')+listButton(m.id)+ib('skip','data-status="'+m.id+'" data-value="'+(s==='skip'?'none':'skip')+'"',s==='skip'?'Ne plus ignorer':'Ignorer',s==='skip')+'</div>'};
function filmCard(m,mode=view,release=false){
const related=tab==='now-playing'&&!selected&&followedMovieCredits().has(Number(m.id));
const directors=directorPreview(m);
const date=m.release_date?(tab==='now-playing'&&!selected?new Date(m.release_date+'T12:00:00').toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'}):m.release_date.slice(0,4)):'Date inconnue';
return '<article class="mq-entity mq-movie '+(status(m.id)==='skip'?'mq-ignored ':status(m.id)==='seen'?'mq-related mq-watched ':'')+(related?'mq-related ':'')+(mode==='list'?'mq-row':'mq-tile')+'" data-open-film="'+m.id+'" tabindex="0" role="link" aria-label="Fiche de '+esc(m.title)+'">'+(mode==='list'?'':'<div class="mq-art">'+(movieCover(m)?mediaImage(poster(movieCover(m)),'movie',{lazy:true}):placeholder('movie'))+'</div>')+'<div class="mq-meta"><h3>'+esc(m.title)+'</h3>'+directors+'<small class="mq-release-date">'+esc(date)+'</small></div>'+movieActions(m)+'</article>'
}
function filmList(items,mode=view,release=false){return items.length?'<div class="'+(mode==='list'?'mq-table':'mq-grid')+'">'+items.map(m=>filmCard(m,mode,release)).join('')+'</div>':'<div class="empty">Aucun film à afficher.</div>'}
function switches(){return modeSwitch('view',view)}
const SUGGESTION_GENRES=[['all','Tous les genres'],[28,'Action'],[12,'Aventure'],[35,'Comédie'],[18,'Drame'],[14,'Fantastique'],[27,'Horreur'],[9648,'Mystère'],[10749,'Romance'],[878,'Science-fiction'],[53,'Thriller'],[16,'Animation']];
const suggestionDecadeOptions=Array.from({length:11},(_,i)=>2020-i*10);
const spectacles=()=>followedMovieIndex().filter(m=>isSpectacle(m)&&!['seen','skip'].includes(state.statuses[m.id]||'none')).sort((a,b)=>(b.vote_average||0)-(a.vote_average||0));
const documentaries=()=>followedMovieIndex().filter(m=>bonusCategory(m)&&!['seen','skip'].includes(state.statuses[m.id]||'none')).sort((a,b)=>(b.vote_average||0)-(a.vote_average||0));
const FILTER_COUNTRIES=[['US','États-Unis'],['FR','France'],['KR','Corée du Sud'],['JP','Japon'],['GB','Royaume-Uni'],['DE','Allemagne'],['IT','Italie'],['ES','Espagne'],['CA','Canada'],['IN','Inde']];
const passesExtraFilters=m=>{const d=filmCache.get(Number(m.id))||m;return (suggestionRuntime==='all'||(Number(d.runtime)>0&&(suggestionRuntime==='lt90'?Number(d.runtime)<90:suggestionRuntime==='90-120'?Number(d.runtime)>=90&&Number(d.runtime)<120:suggestionRuntime==='120-150'?Number(d.runtime)>=120&&Number(d.runtime)<150:suggestionRuntime==='150-180'?Number(d.runtime)>=150&&Number(d.runtime)<=180:Number(d.runtime)>180)))&&(!suggestionCountries.length||(d.production_countries||[]).some(x=>suggestionCountries.includes(x.iso_3166_1)))};
function extraFilterMarkup(){return '<h3>Durée du film</h3><div class="suggestion-chips">'+[['all','Toutes'],['lt90','Moins de 1 h 30'],['90-120','1 h 30 à 2 h'],['120-150','2 h à 2 h 30'],['150-180','2 h 30 à 3 h'],['gt180','Plus de 3 h']].map(([v,label])=>'<button data-suggestion-runtime="'+v+'" class="'+(suggestionRuntime===v?'active':'')+'">'+label+'</button>').join('')+'</div><h3>Pays de production</h3><div class="suggestion-chips"><button data-suggestion-country="all" class="'+(!suggestionCountries.length?'active':'')+'">Tous</button>'+FILTER_COUNTRIES.map(([v,label])=>'<button data-suggestion-country="'+v+'" class="'+(suggestionCountries.includes(v)?'active':'')+'">'+label+'</button>').join('')+'</div>'+(filterMetadataLoading?'<p class="muted">Chargement des informations TMDB…</p>':'')}
async function hydrateFilterMetadata(){if(filterMetadataLoading||(!suggestionCountries.length&&suggestionRuntime==='all')||(tab==='watched'&&watchedMediaTab==='series'))return;filterMetadataLoading=true;try{const items=tab==='watched'?watchedMovies():tab==='now-playing'?[...nowPlaying,...upcomingMovies]:tab==='queue'?followedMovieIndex():exploreSuggestionTab==='documentaries'?documentaries():exploreSuggestionTab==='spectacles'?spectacles():queueMovies();const missing=items.filter(m=>{const d=filmCache.get(Number(m.id));return !d||d.runtime===undefined||!Array.isArray(d.production_countries)}).slice(0,tab==='now-playing'||tab==='watched'?items.length:80);for(let i=0;i<missing.length;i+=4){await Promise.allSettled(missing.slice(i,i+4).map(async m=>{const d=await request('/api/movie/'+m.id);filmCache.set(Number(m.id),d)}))}}finally{filterMetadataLoading=false;render()}}
const suggestions=()=>queueMovies().filter(m=>passesExtraFilters(m)&&m.poster_path&&(!m.release_date||(Number(m.release_date.slice(0,4))>=suggestionMinYear&&Number(m.release_date.slice(0,4))<=suggestionMaxYear))&&(!suggestionGenres.length||suggestionGenres.some(g=>(m.genre_ids||m.genres?.map(x=>x.id)||[]).includes(Number(g))))&&(!suggestionDecades.length||(m.release_date&&suggestionDecades.includes(Math.floor(Number(m.release_date.slice(0,4))/10)*10)))).sort((a,b)=>(b.vote_average||0)-(a.vote_average||0));
function mediaTabs(type,active,options){return '<div class="media-tabs" role="tablist">'+options.map(([id,label])=>'<button type="button" role="tab" aria-selected="'+(active===id)+'" class="media-tab '+(active===id?'active':'')+'" data-'+type+'="'+id+'">'+label+'</button>').join('')+'</div>'}
const seriesSuggestions=()=>followedSeries().filter(m=>!['seen','skip'].includes(seriesState(m.id).status)&&(!m.first_air_date||(Number(m.first_air_date.slice(0,4))>=suggestionMinYear&&Number(m.first_air_date.slice(0,4))<=suggestionMaxYear))&&(!suggestionGenres.length||suggestionGenres.some(g=>(m.genre_ids||[]).includes(Number(g)))));
const spectacleSuggestions=()=>spectacles().filter(m=>passesExtraFilters(m)&&(!m.release_date||(Number(m.release_date.slice(0,4))>=suggestionMinYear&&Number(m.release_date.slice(0,4))<=suggestionMaxYear)));
const docSuggestions=()=>documentaries().filter(m=>passesExtraFilters(m)&&(!m.release_date||(Number(m.release_date.slice(0,4))>=suggestionMinYear&&Number(m.release_date.slice(0,4))<=suggestionMaxYear))&&(!suggestionGenres.length||suggestionGenres.some(g=>(m.genre_ids||[]).includes(Number(g)))));
const releasePeriodIsFiltered=()=>suggestionMinYear>1900||suggestionMaxYear<2030;
const filtersAreActive=()=>suggestionGenres.length>0||suggestionDecades.length>0||releasePeriodIsFiltered()||suggestionRuntime!=='all'||suggestionCountries.length>0;
function activeFilterCount(){return Number(suggestionGenres.length>0)+Number(suggestionDecades.length>0)+Number(suggestionMinYear>1900||suggestionMaxYear<2030)+Number(suggestionRuntime!=='all')+Number(suggestionCountries.length>0)}
function filteredResultCount(){if(selected){if(personMediaTab==='series')return (personSeriesCache.get(selected)||[]).filter(m=>matchesText(m.name,personSeriesQuery)&&(!m.first_air_date||(Number(m.first_air_date.slice(0,4))>=suggestionMinYear&&Number(m.first_air_date.slice(0,4))<=suggestionMaxYear))).length;return (people.get(selected)?.movies||[]).filter(m=>matchesMovieTab(m,personMediaTab)&&matchesText(m.title,personFilmQuery)&&passesExtraFilters(m)&&(!m.release_date||(Number(m.release_date.slice(0,4))>=suggestionMinYear&&Number(m.release_date.slice(0,4))<=suggestionMaxYear))).length}if(tab==='watched')return watchedItems().length;if(tab==='queue')return queueFilteredItems().length;if(tab==='explore'){if(exploreSuggestionTab==='series')return seriesSuggestions().length;if(exploreSuggestionTab==='documentaries')return docSuggestions().length;if(exploreSuggestionTab==='spectacles')return spectacleSuggestions().length;return suggestions().length}if(tab==='lists'){const all=sortedLists(),chosen=all.find(x=>x.id===listSelected),ids=chosen?(chosen.movieIds||[]):[...new Set(all.flatMap(x=>x.movieIds||[]))];return ids.map(id=>filmCache.get(Number(id))).filter(Boolean).filter(m=>matchesText(m.title,listQuery)&&passesExtraFilters(m)&&(!m.release_date||(Number(m.release_date.slice(0,4))>=suggestionMinYear&&Number(m.release_date.slice(0,4))<=suggestionMaxYear))).length}if(tab==='now-playing')return [...new Map([...nowPlaying,...upcomingMovies].map(m=>[m.id,m])).values()].filter(m=>matchesMovieFilters(m,nowQuery)).length;if(tab==='explore')return suggestions().length;return 0}
const filterTrigger=(active=filtersAreActive())=>'<button class="icon-only suggestion-filter-trigger '+(active?'has-active-filters':'')+'" data-open-suggestion-filters aria-label="Filtres'+(active?' actifs':'')+'" title="Filtres'+(active?' actifs':'')+'">'+ico('filter')+(active?'<span class="mq-filter-indicator" aria-hidden="true"></span>':'')+'</button>';
const randomTrigger=kind=>'<button class="random-film" data-random-kind="'+kind+'">'+(kind==='series'?'Série':kind==='documentaries'?'Documentaire':kind==='spectacles'?'Spectacle':'Film')+' au hasard ↗</button>';
function seriesSuggestionsMarkup(){const items=seriesSuggestions();if(!items.length&&followingIsLoading(exploreSuggestionTab))return '<section id="suggestions">'+loadingContent(true,'Chargement des suggestions…','',false,exploreView)+'</section>';return '<section class="suggestion-section" id="suggestions"><div class="suggestion-heading"><div class="suggestion-heading-actions">'+filterTrigger()+'</div><div class="suggestion-heading-actions"><span class="suggestion-count">'+items.length+' séries disponibles</span>'+randomTrigger('series')+'</div></div>'+seriesList(items,exploreView)+suggestionFilterDialog()+'</section>'}
function spectacleSuggestionsMarkup(){const all=spectacleSuggestions();if(!all.length&&followingIsLoading(exploreSuggestionTab))return '<section id="suggestions">'+loadingContent(true,'Chargement des suggestions…','',false,exploreView)+'</section>';return '<section class="suggestion-section" id="suggestions"><div class="suggestion-heading"><span class="suggestion-count">'+all.length+' spectacles disponibles</span>'+randomTrigger('spectacles')+'</div>'+pagedMedia(all,'spectacles',exploreView,m=>filmCard(m,exploreView))+suggestionFilterDialog()+'</section>'}
function documentarySuggestionsMarkup(){const all=docSuggestions(),pages=Math.max(1,Math.ceil(all.length/12));if(!all.length&&followingIsLoading(exploreSuggestionTab))return '<section id="suggestions">'+loadingContent(true,'Chargement des suggestions…','',false,exploreView)+'</section>';documentaryPage=Math.min(documentaryPage,pages-1);return '<section class="suggestion-section" id="suggestions"><div class="suggestion-heading"><div class="suggestion-heading-actions">'+filterTrigger()+'</div><div class="suggestion-heading-actions"><span class="suggestion-count">'+all.length+' documentaires disponibles</span>'+randomTrigger('documentaries')+'</div></div>'+filmList(all.slice(documentaryPage*12,documentaryPage*12+12),exploreView)+'<div class="suggestion-pagination"><button data-documentary-page="-1" '+(documentaryPage===0?'disabled':'')+'>←</button><span>Page '+(documentaryPage+1)+' / '+pages+'</span><button data-documentary-page="1" '+(documentaryPage>=pages-1?'disabled':'')+'>→</button></div>'+suggestionFilterDialog()+'</section>'}
let suggestionFilterSnapshot=null;
function saveSuggestionFilterSnapshot(){suggestionFilterSnapshot={genres:[...suggestionGenres],decades:[...suggestionDecades],minYear:suggestionMinYear,maxYear:suggestionMaxYear,runtime:suggestionRuntime,countries:[...suggestionCountries]}}
function closeSuggestionFilters(apply=false){if(!apply&&suggestionFilterSnapshot){suggestionGenres=[...suggestionFilterSnapshot.genres];suggestionDecades=[...suggestionFilterSnapshot.decades];suggestionMinYear=suggestionFilterSnapshot.minYear;suggestionMaxYear=suggestionFilterSnapshot.maxYear;suggestionRuntime=suggestionFilterSnapshot.runtime;suggestionCountries=[...suggestionFilterSnapshot.countries]}suggestionFilterSnapshot=null;suggestionFiltersOpen=false;mediaPages.queue=mediaPages.watched=0;mediaPages.upcoming=0;mediaPages.current=0;render();if(apply)hydrateFilterMetadata()}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&suggestionFiltersOpen){e.preventDefault();e.stopImmediatePropagation();closeSuggestionFilters(false)}},true);
document.addEventListener('click',e=>{if(suggestionFiltersOpen&&e.target.classList?.contains('mq-filter-overlay')){e.preventDefault();e.stopImmediatePropagation();closeSuggestionFilters(false)}},true);
function suggestionFilterDialog({periodOnly=false}={}){return suggestionFiltersOpen?'<div class="mq-filter-overlay"><div class="mq-filter-dialog" role="dialog" aria-modal="true" aria-label="Filtres"><div class="mq-filter-header"><h2>Filtres</h2><button data-cancel-suggestion-filters>×</button></div>'+(periodOnly?'':'<h3>Genres</h3><div class="suggestion-chips"><button data-suggestion-genre="all" class="'+(!suggestionGenres.length?'active':'')+'">Tous</button>'+SUGGESTION_GENRES.filter(([v])=>v!=='all').map(([v,t])=>'<button data-suggestion-genre="'+v+'" class="'+(suggestionGenres.includes(String(v))?'active':'')+'">'+t+'</button>').join('')+'</div>')+'<h3>Période de sortie</h3><div class="mq-filter-years"><div class="mq-range-labels"><span>De <output id="minYearOutput">'+suggestionMinYear+'</output></span><span>À <output id="maxYearOutput">'+suggestionMaxYear+'</output></span></div><div class="mq-double-range"><div class="mq-range-track"></div><div class="mq-range-selected" style="left:'+((suggestionMinYear-1900)/130*100)+'%;right:'+(100-(suggestionMaxYear-1900)/130*100)+'%"></div><input type="range" id="suggestionMinYear" min="1900" max="2030" step="5" value="'+suggestionMinYear+'" aria-label="Année de début"><input type="range" id="suggestionMaxYear" min="1900" max="2030" step="5" value="'+suggestionMaxYear+'" aria-label="Année de fin"></div></div>'+(periodOnly?'':extraFilterMarkup())+'<div class="mq-filter-footer"><button data-reset-suggestion-filters>Réinitialiser</button><button data-apply-suggestion-filters>Afficher <span id="mqFilterResultCount">les '+filteredResultCount()+' résultats</span></button></div></div></div>':''}
function suggestionMarkup(){const all=suggestions(),pages=Math.max(1,Math.ceil(all.length/12));if(!all.length&&followingIsLoading(exploreSuggestionTab))return '<section id="suggestions">'+loadingContent(true,'Chargement des suggestions…','',false,exploreView)+'</section>';suggestionPage=Math.min(suggestionPage,pages-1);const items=all.slice(suggestionPage*12,suggestionPage*12+12);return '<section class="suggestion-section" id="suggestions"><div class="suggestion-heading"><div class="suggestion-heading-actions">'+filterTrigger()+'</div><div class="suggestion-heading-actions"><span class="suggestion-count">'+all.length+' films disponibles</span>'+randomTrigger('films')+'</div></div>'+(items.length?filmList(items,exploreView):'<p class="muted">Aucun film ne correspond à ces filtres.</p>')+'<div class="suggestion-pagination"><button data-suggestion-page="-1" '+(suggestionPage===0?'disabled':'')+'>←</button><span>Page '+(suggestionPage+1)+' / '+pages+'</span><button data-suggestion-page="1" '+(suggestionPage>=pages-1?'disabled':'')+'>→</button></div>'+suggestionFilterDialog()+'</section>'}
async function randomMovie(){const list=suggestions();if(!list.length){error='Aucun film à découvrir avec ces filtres.';render();return}const m=list[Math.floor(Math.random()*list.length)];film=m.id;selected=null;if(!filmCache.get(film)?.credits)filmCache.set(film,await request('/api/movie/'+film));render()}
function loadNowPlaying(){
 if(nowLoaded)return;
 return loadSection('now-playing',async()=>{
  const [current,future]=await Promise.allSettled([request('/api/now-playing'),request('/api/upcoming')]);
  if(current.status==='fulfilled')nowPlaying=current.value.results||[];
  if(future.status==='fulfilled')upcomingMovies=future.value.results||[];
  if(current.status==='rejected'&&tab==='now-playing')error=current.reason.message;
  if(future.status==='rejected')console.warn('Upcoming movies unavailable:',future.reason);
  nowLoaded=current.status==='fulfilled'&&future.status==='fulfilled';
  for(const movie of [...nowPlaying,...upcomingMovies])if(!filmCache.has(movie.id))filmCache.set(movie.id,movie);
 });
}
function hydrateListContent(){
 const all=sortedLists(),chosen=all.find(list=>list.id===listSelected);
 const series=listTabMedia==='series',type=series?'tv':'movie',cache=series?seriesCache:filmCache;
 const ids=[...new Set((chosen?[chosen]:all).flatMap(list=>list[series?'tvIds':'movieIds']||[]).map(Number))]
  .filter(id=>Number.isSafeInteger(id)&&id>0&&!cache.has(id));
 if(!ids.length)return;
 const owner=user,selection=listSelected;
 return loadSection('lists',async()=>{
  for(let i=0;i<ids.length&&user===owner&&tab==='lists'&&!selected&&!film&&!seriesId;i+=5){
   if((listTabMedia==='series')!==series||listSelected!==selection)break;
   await Promise.allSettled(ids.slice(i,i+5).map(async id=>{
    if(!cache.has(id))cache.set(id,await request('/api/'+type+'/'+id));
   }));
  }
 },['list:'+selection,...ids.map(id=>type+':'+id)]);
}
function setLayout(mode){if(mode!=='cards'&&mode!=='list')return;if(view!==mode)mediaPages.queue=mediaPages.watched=0;view=mode;exploreView=mode;followingView=mode;releaseView=mode;nowView=mode;castView=mode;seriesView=mode;listView=mode;try{localStorage.setItem('moviequest-layout',JSON.stringify({mode}))}catch(e){/* Private browsing may disable storage. */}render()}

let releaseCalendarOffset=0;
const monthName=d=>d.toLocaleDateString('fr-FR',{month:'long',year:'numeric'});
const todayIso=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Paris'});
function matchesMovieFilters(m,q){
 const year=Number((m.release_date||'').slice(0,4)),genres=m.genre_ids||m.genres?.map(g=>g.id)||[];
 return matchesText(m.title||'',q)&&passesExtraFilters(m)&&(!year||(year>=suggestionMinYear&&year<=suggestionMaxYear))&&(!suggestionGenres.length||suggestionGenres.some(g=>genres.includes(Number(g))))&&(!suggestionDecades.length||(year&&suggestionDecades.includes(Math.floor(year/10)*10)));
}
function nowPlayingSections(q=nowQuery){
 if(sectionLoads.has('now-playing')&&!nowPlaying.length&&!upcomingMovies.length)return loadingContent(true,'Chargement des sorties cinéma…','',false,nowView);
 const today=todayIso(),byId=new Map([...nowPlaying,...upcomingMovies].filter(m=>m.id&&m.release_date).map(m=>[m.id,m]));
 const list=[...byId.values()].filter(m=>matchesMovieFilters(m,q));
 const upcoming=list.filter(m=>m.release_date>today).sort((a,b)=>a.release_date.localeCompare(b.release_date));
 const current=list.filter(m=>m.release_date<=today&&nowPlaying.some(n=>n.id===m.id)).sort((a,b)=>b.release_date.localeCompare(a.release_date));
 return loadingContent(sectionLoads.has('now-playing'),'Actualisation des sorties cinéma…','',true)+'<section class="mq-now-section"><h2>À venir <span class="mq-now-count">'+upcoming.length+'</span></h2><p class="muted">Prochaines sorties françaises référencées par TMDB.</p>'+pagedMedia(upcoming,'upcoming',nowView,m=>filmCard(m,nowView))+'</section><section class="mq-now-section"><h2>Encore à l’affiche <span class="mq-now-count">'+current.length+'</span></h2><p class="muted">Films récemment sortis selon la sélection « Now Playing » de TMDB (sans garantie de séances).</p>'+pagedMedia(current,'current',nowView,m=>filmCard(m,nowView))+'</section>';
}
function releaseCalendarMarkup(){
 const today=new Date(),base=new Date(today.getFullYear(),today.getMonth()+releaseCalendarOffset,1),year=base.getFullYear(),month=base.getMonth();
 const first=(base.getDay()+6)%7,days=new Date(year,month+1,0).getDate();
 const candidates=new Map();
 const add=(item,kind,date)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))return;if(Number(date.slice(0,4))!==year||Number(date.slice(5,7))!==month+1)return;const day=Number(date.slice(8,10));if(!candidates.has(day))candidates.set(day,[]);const bucket=candidates.get(day);if(!bucket.some(x=>x.kind===kind&&x.id===item.id))bucket.push({id:item.id,kind,title:item.title||item.name})};
 for(const m of [...followedMovieIndex(),...nowPlaying,...upcomingMovies])add(m,'movie',m.release_date);
 for(const m of followedSeries())add(m,'tv',m.first_air_date);
 const weekdays=['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
 const cells=Array.from({length:first},()=>'<div class="mq-calendar-empty" aria-hidden="true"></div>');
 for(let day=1;day<=days;day++){const events=candidates.get(day)||[],isToday=day===today.getDate()&&month===today.getMonth()&&year===today.getFullYear();cells.push('<div class="mq-calendar-day '+(isToday?'is-today':'')+'"><span class="mq-calendar-day-number">'+day+'</span>'+events.slice(0,4).map(x=>'<button class="mq-calendar-event" type="button" '+(x.kind==='tv'?'data-open-tv':'data-open-film')+'="'+x.id+'" title="'+esc(x.title)+'">'+(x.kind==='tv'?'▣ ':'● ')+esc(x.title)+'</button>').join('')+(events.length>4?'<small>+'+(events.length-4)+' autres</small>':'')+'</div>')}
 return '<section class="mq-calendar-section"><div class="mq-calendar-toolbar"><div><h2>Calendrier des sorties</h2><p class="muted">Films à l’affiche et sorties des personnalités suivies, selon les dates TMDB.</p></div><div class="mq-calendar-nav"><button type="button" data-calendar-move="-1" aria-label="Mois précédent">←</button><strong>'+esc(monthName(base))+'</strong><button type="button" data-calendar-move="1" aria-label="Mois suivant">→</button><button type="button" data-calendar-today>Ce mois</button></div></div><div class="mq-calendar-grid">'+weekdays.map(x=>'<span class="mq-calendar-weekday">'+x+'</span>').join('')+cells.join('')+'</div></section>';
}
function cinephileStatsMarkup(){
 const index=followedMovieIndex(),seen=index.filter(m=>state.statuses[m.id]==='seen'),counts=(items,get)=>{const map=new Map();for(const m of items){const values=get(m);for(const v of new Set(values))map.set(v,(map.get(v)||0)+1)}return [...map].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0],'fr')))};
 const decades=counts(seen,m=>{const y=Number((m.release_date||'').slice(0,4));return y>1800?[Math.floor(y/10)*10+'s']:[]}).sort((a,b)=>Number(a[0])-Number(b[0]));
 const genres=counts(seen,m=>(filmCache.get(Number(m.id))?.genres||m.genres||[]).map(g=>g.name).filter(Boolean));
 const countries=counts(seen,m=>(filmCache.get(Number(m.id))?.production_countries||m.production_countries||[]).map(x=>x.name).filter(Boolean));
 const directors=counts(seen,m=>(filmCache.get(Number(m.id))?.credits?.crew||[]).filter(p=>p.job==='Director').map(p=>p.name));
 const minutes=seen.reduce((sum,m)=>sum+(Number(filmCache.get(Number(m.id))?.runtime||m.runtime)||0),0),withRuntime=seen.filter(m=>Number(filmCache.get(Number(m.id))?.runtime||m.runtime)>0).length;
 const bars=(entries)=>entries.length?'<div class="mq-stat-bars">'+entries.slice(0,8).map(([name,n])=>'<div class="mq-stat-bar"><span>'+esc(name)+'</span><div class="mq-stat-track"><div style="width:'+(n/entries[0][1]*100)+'%"></div></div><b>'+n+'</b></div>').join('')+'</div>':'<p class="muted">Pas encore assez de données pour cette répartition.</p>';
 return '<section class="mq-cinephile-stats"><h2>Statistiques cinéphiles avancées</h2><p class="muted">Calculées à partir des films marqués comme vus et des métadonnées TMDB disponibles.</p><div class="mq-cinephile-kpis"><div><strong>'+seen.length+'</strong><span>Films vus</span></div><div><strong>'+Math.floor(minutes/60)+' h '+String(minutes%60).padStart(2,'0')+'</strong><span>Durée connue · '+withRuntime+' films</span></div><div><strong>'+decades.length+'</strong><span>Décennies explorées</span></div></div><div class="mq-stat-panels"><section><h3>Par décennie</h3>'+bars(decades)+'</section><section><h3>Genres les plus vus</h3>'+bars(genres)+'</section><section><h3>Pays de production</h3>'+bars(countries)+'</section><section><h3>Réalisateurs les plus vus</h3>'+bars(directors)+'</section></div></section>';
}
function libraryNavigation(){
 const links=Object.entries(librarySections).map(([key,{label,icon}])=>
  '<button type="button" data-library-tab="'+key+'"'+(tab===key?' aria-current="page"':'')+'>'+ico(icon)+'<span>'+label+'</span></button>'
 ).join('');
 return '<div class="mq-library-heading"><h1>Bibliothèque</h1><p>Tes sélections et ton historique de visionnage.</p></div>'+
  '<nav class="mq-library-nav" aria-label="Sections de la bibliothèque">'+links+'</nav>';
}
function render(){if(!authReady)return;if(user){sessionStorage.setItem('moviequest-view',JSON.stringify({tab,selected,film,tv:seriesId}));syncRoute()}const focusedSagaMovie=document.activeElement?.dataset.sagaMoviePick;
const sagaMatchesScroll=document.getElementById('sagaMovieMatches')?.scrollTop;
const focusedLibraryTab=document.activeElement?.dataset.libraryTab;const focusedSearch=document.activeElement?.matches?.('input[type=search], #sagaSearch, #sagaMovieSearch')?document.activeElement:null;const searchCaret=focusedSearch?[focusedSearch.selectionStart,focusedSearch.selectionEnd]:null;document.body.classList.remove('app-booting');const mobileToggle=document.getElementById('mobileNavToggle'),mainNav=document.getElementById('mainNav');mobileToggle.hidden=!user;mobileToggle.setAttribute('aria-expanded',String(mobileNavOpen));mobileToggle.setAttribute('aria-label',mobileNavOpen?'Fermer le menu':'Ouvrir le menu');mobileToggle.classList.toggle('is-open',mobileNavOpen);mainNav.classList.toggle('mobile-open',mobileNavOpen);document.body.classList.toggle('mobile-menu-active',mobileNavOpen&&!!user);document.querySelector('nav').hidden=!user;document.querySelector('footer').hidden=!user;if(!authReady){document.getElementById('account').innerHTML='';el.innerHTML='<div class="auth-screen"><div class="auth-panel"><div class="eyebrow">Movie Quest</div><h1>Chargement de la session…</h1></div></div>';return}if(!user){document.getElementById('account').innerHTML='';el.innerHTML='<div class="auth-screen"><div class="auth-panel"><div class="eyebrow">Bienvenue dans Movie Quest</div><h1>Le cinéma est une quête.</h1><p>Connecte-toi avec Google pour explorer les filmographies et retrouver ta progression personnelle.</p>'+btn('Continuer avec Google','id="login"','gold')+'</div></div>';return}mainNav.querySelectorAll('button[data-tab]').forEach(b=>{
 const active=isLibraryEntry(b.dataset.tab)?isLibraryTab(tab):b.dataset.tab===tab;
 b.classList.toggle('active',active);
 if(active)b.setAttribute('aria-current','page');
 else b.removeAttribute('aria-current');
});document.getElementById('account').innerHTML=user?'<div class="account-wrap"><button id="accountToggle" class="account-trigger" aria-label="Menu du compte" aria-expanded="'+menuOpen+'">'+(user.photoURL?'<img class="account-avatar" src="'+esc(user.photoURL)+'" alt="">':'<span class="account-initials">'+esc((user.displayName||user.email||'?').trim().split(/\\s+/).map(x=>x[0]).slice(0,2).join('').toUpperCase())+'</span>')+'</button>'+(menuOpen?'<div class="account-menu" role="menu"><button data-tab="profile" role="menuitem" class="account-profile"><strong>'+esc(user.displayName||user.email)+'</strong><small>Voir mon profil</small></button><div class="account-menu-divider"></div><button id="logout" role="menuitem">Déconnexion</button></div>':'')+'</div>':btn('Connexion Google','id="login"','gold');let h=error?'<div class="notice">'+esc(error)+'</div>':'';
if(seriesId){el.innerHTML=h+seriesDetailMarkup()+listModalMarkup();return}if(film){const m=filmCache.get(film);if(!m){el.innerHTML=h+loadingContent(!error,'Chargement de la fiche du film…','',false,'detail');return}if(m){const directors=(m.credits?.crew||[]).filter(x=>x.job==='Director'),actors=(m.credits?.cast||[]).slice(0,18);h+=loadingContent(sectionLoads.has('movie:'+film),'Chargement de la fiche du film…','',true)+'<div class="detail detailtop">'+(movieCover(m)?'<button class="mq-poster-zoom" type="button" data-zoom-poster="'+esc(movieCover(m))+'" data-poster-title="'+esc(m.title)+'" aria-label="Agrandir l’affiche de '+esc(m.title)+'">'+mediaImage(poster(movieCover(m),'w500'),'movie',{alt:'Affiche de '+m.title})+'<span class="mq-poster-zoom-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></span></button>':placeholder('movie'))+'<div><h1>'+esc(m.title)+'</h1>'+tmdbLink('movie',m.id||film)+'<p>'+esc((m.release_date||'').slice(0,4))+'</p><div class="credit-line"><strong>Réalisation</strong> '+(directors.length?directors.map(p=>'<button class="credit-link" data-credit-person="'+p.id+'" data-role="director" data-name="'+esc(p.name)+'">'+esc(p.name)+'</button>').join(' · '):'Non renseignée')+'</div><div class="movie-facts">'+(m.runtime?'<div class="movie-duration">Durée : '+Math.floor(m.runtime/60)+' h '+String(m.runtime%60).padStart(2,'0')+'</div>':'')+(m.genres?.length?'<div class="mq-movie-genres">'+m.genres.map(g=>'<span class="mq-genre">'+esc(g.name)+'</span>').join('')+'</div>':'')+(m.vote_count?'<div class="movie-rating"><span class="rating-stars" aria-label="Note '+Number(m.vote_average||0).toFixed(1)+' sur 10"><span class="rating-stars-base">★★★★★</span><span class="rating-stars-fill" style="width:'+Math.min(100,Math.max(0,Number(m.vote_average||0)*10))+'%">★★★★★</span></span><span class="rating-value">'+Number(m.vote_average||0).toFixed(1)+'/10 · '+m.vote_count+' votes TMDB</span></div>':'')+'</div><p>'+esc(m.overview||'Résumé indisponible.')+'</p>'+movieActions(m)+listPickerMarkup(m.id)+'</div></div>'+(actors.length?'<section class="credits-section"><h2>Distribution</h2>'+filterBar({id:'castSearch',queryValue:castQuery,placeholder:'Rechercher dans la distribution…',field:'cast-view',mode:castView})+'<div id="castSearchResults">'+castMarkup(actors.filter(p=>matchesText(p.name,castQuery)||matchesText(p.character,castQuery)))+'</div></section>':'')}el.innerHTML=h+listModalMarkup();return}
if(selected){const p=state.following[selected]||knownPeople.get(selected)||results.find(x=>x.id===selected)||currentPerson;const record=people.get(selected),profile=record?.profile||{},allMovies=record?.movies||[],list=allMovies.filter(m=>(matchesMovieTab(m,personMediaTab))&&(personFilmRole==='all'||(m.person_roles||[p?.role||'actor']).includes(personFilmRole))),birth=profile.birthday?new Date(profile.birthday+'T12:00:00'):null,death=profile.deathday?new Date(profile.deathday+'T12:00:00'):null,age=birth?Math.max(0,(death||new Date()).getFullYear()-birth.getFullYear()-((death||new Date()).getMonth()<birth.getMonth()||((death||new Date()).getMonth()===birth.getMonth()&&(death||new Date()).getDate()<birth.getDate())?1:0)):null;h+='<div class="hero person-profile-hero">'+(profile.profile_path||p?.profile_path?mediaImage(poster(profile.profile_path||p.profile_path,'w500'),'person',{alt:'Portrait de '+(p?.name||''),className:'person-profile-photo'}):placeholder('person'))+'<div class="person-profile-content"><div class="eyebrow">'+(p?.role==='director'?'Réalisation':'Interprétation')+'</div><h1>'+esc(profile.name||p?.name||'Filmographie')+'</h1>'+tmdbLink('person',selected)+'<div class="person-profile-facts">'+(age!==null?'<span>'+age+' ans'+(death?' (décédé)':'')+'</span>':'')+(profile.place_of_birth?'<span>'+esc(profile.place_of_birth)+'</span>':'')+(birth?'<span>Né'+(profile.gender===1?'e':'')+' le '+birth.toLocaleDateString('fr-FR')+'</span>':'')+'</div>'+(profile.biography?responsiveDescription(profile.biography,'Biographie'):'')+'<p>'+complete(list)+' / '+list.length+' films traités · '+list.filter(m=>status(m.id)==='seen').length+' vus</p><div class="progress"><div style="width:'+(list.length?complete(list)/list.length*100:0)+'%"></div></div>'+ib(state.following[selected]?'check':'plus','data-follow="'+selected+'"',state.following[selected]?'Ne plus suivre':'Suivre',!!state.following[selected])+'</div></div>'+mediaTabs('person-media',personMediaTab,[['films','Films'],['series','Séries'],['documentaries','Documentaires'],['spectacles','Spectacles']])+(personMediaTab==='series'?'<section class="person-series"><h2>Séries TV</h2>'+filterBar({id:'personSeriesSearch',queryValue:personSeriesQuery,placeholder:'Rechercher une série TV…',field:'view',mode:view,extra:filterTrigger()})+'<div id="personSeriesSearchResults">'+loadingContent(sectionLoads.has('person-series:'+selected),'Chargement des séries…',seriesList((personSeriesCache.get(selected)||[]).filter(m=>matchesText(m.name,personSeriesQuery)),view),personSeriesCache.get(selected)?.length,view)+'</div></section>':'<section class="person-filmography"><h2>'+(personMediaTab==='films'?'Filmographie':personMediaTab==='spectacles'?'Spectacles':'Documentaires et making-of')+'</h2>'+filterBar({id:'personFilmSearch',queryValue:personFilmQuery,placeholder:'Rechercher un titre…',field:'view',mode:view,extra:filterTrigger(),chips:[['all','Tous',personFilmRole==='all','person-film-role'],['actor','Acteur',personFilmRole==='actor','person-film-role'],['director','Réalisateur',personFilmRole==='director','person-film-role']]})+'<div id="personFilmSearchResults">'+loadingContent(personRequests.has(selected),'Chargement de la filmographie…',filmList(list.filter(m=>matchesText(m.title,personFilmQuery)&&passesExtraFilters(m))),list.length,view)+'</div></section>');el.innerHTML=h+listModalMarkup()+suggestionFilterDialog();return}


if(tab==='profile'){
const avatar=user?.photoURL?'<img class="profile-avatar" src="'+esc(user.photoURL)+'" alt="">':'<span class="profile-avatar profile-fallback">'+esc((user?.displayName||user?.email||'?').slice(0,2).toUpperCase())+'</span>';
const lastLogin=user?.metadata?.lastSignInTime?new Date(user.metadata.lastSignInTime).toLocaleString('fr-FR'):'Non disponible';
const created=user?.metadata?.creationTime?new Date(user.metadata.creationTime).toLocaleDateString('fr-FR'):'Non disponible';
const currentAccent=state.preferences?.accent||'#3bdd0e';
h+='<div class="hero"><div class="eyebrow">Mon espace</div><h1>Mon profil</h1><div class="profile-identity">'+avatar+'<div><h2>'+esc(user?.displayName||'Compte Google')+'</h2><p>'+esc(user?.email||'')+'</p></div></div></div>';
h+='<section class="profile-panel"><h2>Apparence</h2><p>Personnalise la couleur principale de Movie Quest.</p><div class="accent-swatches">'+ACCENTS.map(color=>'<button class="accent-swatch '+(currentAccent.toLowerCase()===color?'selected':'')+'" data-accent="'+color+'" style="--swatch:'+color+'" title="'+color+'" aria-label="Choisir la couleur '+color+'" aria-pressed="'+(currentAccent.toLowerCase()===color)+'"></button>').join('')+'</div><label class="custom-accent">Couleur personnalisée <input type="color" id="accentColor" value="'+esc(currentAccent)+'"></label></section>';
h+='<section class="profile-panel"><h2>Compte et sécurité Google</h2><div class="profile-detail"><span>Dernière connexion</span><strong>'+esc(lastLogin)+'</strong></div><div class="profile-detail"><span>Compte créé le</span><strong>'+esc(created)+'</strong></div><p class="small">Firebase fournit la dernière connexion connue, pas l’historique complet des connexions. La gestion du mot de passe, des appareils et de la sécurité se fait sur ton compte Google.</p><div class="profile-links"><a href="https://myaccount.google.com/personal-info" target="_blank" rel="noopener noreferrer">Informations personnelles Google ↗</a><a href="https://myaccount.google.com/security" target="_blank" rel="noopener noreferrer">Sécurité du compte Google ↗</a><a href="https://myaccount.google.com/device-activity" target="_blank" rel="noopener noreferrer">Appareils et sessions Google ↗</a></div></section>';
h+='<section class="profile-panel"><h2>Connexion à TMDB</h2><p>Adresse du Cloudflare Worker utilisé pour la recherche de films. Le jeton TMDB reste stocké dans les secrets Cloudflare.</p><div class="api-settings"><label for="apiOrigin">URL du Worker</label><input id="apiOrigin" type="url" placeholder="https://movie-quest.example.workers.dev" value="'+esc(API)+'">'+btn('Enregistrer','id="saveApi"','gold')+'</div><a href="'+esc(API)+'/health" target="_blank" rel="noopener noreferrer" class="health-link">Vérifier le endpoint /health ↗</a></section>';
h+='<section class="profile-panel mq-placeholder-preview"><h2>Aperçu des visuels sans image</h2><p>Exemples de contrôle visuel, sans ajout à tes données.</p><div class="mq-preview-grid"><div class="mq-preview-card"><div class="mq-preview-art">'+placeholder('movie')+'</div><strong>Film sans affiche</strong></div><div class="mq-preview-card"><div class="mq-preview-art">'+placeholder('collection')+'</div><strong>Collection sans couverture</strong></div><div class="mq-preview-card"><div class="mq-preview-art">'+placeholder('person')+'</div><strong>Personnalité sans portrait</strong></div></div></section>';
}
if(tab==='explore'){h+='<div class="hero"><div class="eyebrow">Movie Quest</div><h1>Explore. Suis. Complète.</h1><p>Recherche un film, une série, un acteur ou un réalisateur dans TMDB.</p></div><div class="unified-filters explore-toolbar">'+filterTrigger()+'<div class="search-field"><input id="search" type="search" placeholder="Rechercher un film, une série ou une personnalité…" value="'+esc(query)+'" autocomplete="off"><button id="clearExploreSearch" class="search-clear" type="button" aria-label="Effacer la recherche" title="Effacer la recherche" '+(query?'':'hidden')+'>×</button></div><div class="filter-chips">'+[['all','Tout'],['actor','Acteurs'],['director','Réalisateurs'],['movie','Films'],['tv','Séries']].map(([v,t])=>btn(t,'data-filter="'+v+'"',filter===v?'active':'')).join('')+'</div><div id="exploreViewSwitch" class="explore-view-switch">'+modeSwitch('explore-view',exploreView)+'</div></div><p id="searchState" class="muted"></p><div id="exploreResults">'+exploreResultsMarkup()+'</div>'+'<section class="mq-suggestion-group"><h2>Suggestions de '+(exploreSuggestionTab==='films'?'films':exploreSuggestionTab==='series'?'séries':exploreSuggestionTab==='spectacles'?'spectacles':'documentaires')+'</h2>'+mediaTabs('explore-suggestions',exploreSuggestionTab,[['films','Films'],['series','Séries'],['documentaries','Documentaires'],['spectacles','Spectacles']])+(exploreSuggestionTab==='films'?suggestionMarkup():exploreSuggestionTab==='series'?seriesSuggestionsMarkup():exploreSuggestionTab==='spectacles'?spectacleSuggestionsMarkup():documentarySuggestionsMarkup())+'</section>'}
if(tab==='explore'){const owners=followed().filter(p=>releaseRole==='all'||p.role===releaseRole),options=owners.map(p=>'<option value="'+esc(p.name)+'">').join('');h+='<h2>Sorties de mes personnalités</h2>'+mediaTabs('release-media',releaseMediaTab,[['films','Films'],['series','Séries'],['documentaries','Documentaires'],['spectacles','Spectacles']])+'<p>Films récents et séries actuellement diffusées avec les personnalités que tu suis.</p>'+filterBar({id:'releaseSearch',queryValue:releaseQuery,placeholder:'Rechercher une personnalité, un film, une série ou un documentaire…',field:'release-view',mode:releaseView,extra:filterTrigger(),chips:[['all','Tous',releaseRole==='all','release-role'],['actor','Acteurs',releaseRole==='actor','release-role'],['director','Réalisateurs',releaseRole==='director','release-role']]})+'<div id="releaseSearchResults">'+releaseMarkup()+'</div>'+suggestionFilterDialog()}

if(tab==='now-playing'){h+='<div class="hero"><div class="eyebrow">Cinéma en France</div><h1>À l’affiche</h1><p>Découvre les prochaines sorties et les films récemment sortis en France.</p></div>'+filterBar({id:'nowSearch',queryValue:nowQuery,placeholder:'Rechercher un film à l’affiche…',field:'now-view',mode:nowView,extra:filterTrigger()})+'<div id="nowSearchResults">'+nowPlayingSections(nowQuery)+'</div>'+(sectionLoads.has('now-playing')&&!nowPlaying.length&&!upcomingMovies.length?'':releaseCalendarMarkup())+suggestionFilterDialog()}

if(tab==='following'){const matching=followed().filter(p=>(followingRole==='all'||p.role===followingRole)&&p.name.toLocaleLowerCase('fr').includes(followingQuery.trim().toLocaleLowerCase('fr')));h+='<div class="hero"><div class="eyebrow">Ta collection</div><h1>Mes personnalités</h1><p>Retrouve tes acteurs et réalisateurs favoris, et suis ta progression film après film.</p></div><div class="stat-grid mq-following-stats">'+[['Personnalités suivies',followed().length],['Acteurs',followed().filter(p=>p.role==='actor').length],['Réalisateurs',followed().filter(p=>p.role==='director').length]].map(([label,n])=>'<div class="stat-tile"><strong>'+n+'</strong><span>'+label+'</span></div>').join('')+'</div>'+filterBar({id:'followingSearch',queryValue:followingQuery,placeholder:'Rechercher parmi mes personnalités…',field:'following-view',mode:followingView,chips:[['all','Tous',followingRole==='all','following-role'],['actor','Acteurs',followingRole==='actor','following-role'],['director','Réalisateurs',followingRole==='director','following-role']]})+'<div id="followingResults">'+loadingContent(followingIsLoading('movies'),'Chargement de tes personnalités…',personList(matching,followingView),matching.length,followingView)+'</div>'}

if(isLibraryTab(tab))h+=libraryNavigation();
if(tab==='collections')h+=sagaMarkup();
if(tab==='lists')h+=listCollectionMarkup();
if(tab==='stats'){const all=films(),summary=completion(all,state.statuses),months=byMonth(all,state.statuses,state.seenAt),top=followed().map(p=>({name:p.name,...completion(people.get(p.id)?.movies||[],state.statuses)})).sort((a,b)=>b.percent-a.percent);h+='<div class="hero"><div class="eyebrow">Tableau de progression</div><h1>Statistiques</h1><p>Ta quête cinéphile en chiffres</p></div>'+loadingContent(followingIsLoading('movies')||followingIsLoading('series')||sectionLoads.has('stats-history'),'Chargement des statistiques…','',true)+'<div class="stat-grid">'+[['Films recensés',summary.total],['Films vus',summary.seen],['Films écartés',summary.skipped],['À compléter',summary.remaining],['Progression',summary.percent+'%'],['Personnalités suivies',followed().length],['Séries recensées',followedSeries().length],['Séries à compléter',followedSeries().filter(m=>seriesState(m.id).status==='todo').length],['Documentaires recensés',followedMovieIndex().filter(m=>bonusCategory(m)).length],['Documentaires à compléter',documentaries().length],['Acteurs suivis',followed().filter(p=>p.role==='actor').length],['Réalisateurs suivis',followed().filter(p=>p.role==='director').length],['Séries terminées',followedSeries().filter(m=>seriesState(m.id).status==='seen').length],['Documentaires vus',followedMovieIndex().filter(m=>bonusCategory(m)&&state.statuses[m.id]==='seen').length]].map(([label,value])=>'<div class="stat-tile"><strong>'+value+'</strong><span>'+label+'</span></div>').join('')+'</div><h2>Visionnages par mois</h2><div class="month-chart">'+(months.length?months.slice(-12).map(m=>'<div class="month-row"><span>'+esc(m.month)+'</span><div class="month-track"><div style="width:'+(m.count/Math.max(...months.map(x=>x.count))*100)+'%"></div></div><b>'+m.count+'</b></div>').join(''):'<p>Aucun visionnage daté pour le moment.</p>')+'</div>'+cinephileStatsMarkup()+'<h2>Progression par personnalité</h2>'+top.map(p=>'<div class="stat-person"><button type="button" class="stat-person-link" data-open-person="'+(followed().find(x=>x.name===p.name)?.id||'')+'">'+esc(p.name)+'</button><b>'+p.seen+' vus · '+p.skipped+' ignorés · '+p.percent+'%</b><div class="progress"><div style="width:'+p.percent+'%"></div></div></div>').join('')}


if(tab==='watched'){h+='<div class="mq-library-section-heading"><h2>Vus</h2><p>Retrouve les films, séries, documentaires et spectacles que tu as vus.</p></div>'+mediaTabs('watched-media',watchedMediaTab,[['films','Films'],['series','Séries'],['documentaries','Documentaires'],['spectacles','Spectacles']])+watchedToolbar()+'<div id="watchedSearchResults" tabindex="-1">'+watchedResultsMarkup()+'</div>'+suggestionFilterDialog({periodOnly:watchedMediaTab==='series'})}
if(tab==='queue'){h+='<div class="mq-library-section-heading"><h2>À compléter</h2><p>Retrouve ta sélection et les contenus qu’il te reste à découvrir.</p></div>'+mediaTabs('queue-media',queueMediaTab,[['films','Films'],['series','Séries'],['documentaries','Documentaires'],['spectacles','Spectacles']])+'<div class="queue-unified-toolbar">'+filterBar({id:'queueSearch',queryValue:queueQuery,placeholder:'Rechercher dans les contenus à compléter…',field:'view',mode:view,extra:filterTrigger()+randomTrigger(queueMediaTab)})+'</div>'+'<div id="queueSearchResults" tabindex="-1">'+queueResultsMarkup(queueQuery)+'</div>'+suggestionFilterDialog()}

el.innerHTML=h+listModalMarkup();
const matches=document.getElementById('sagaMovieMatches');
if(matches&&sagaMatchesScroll!==undefined)matches.scrollTop=sagaMatchesScroll;
if(focusedSagaMovie)matches?.querySelector('[data-saga-movie-pick="'+CSS.escape(focusedSagaMovie)+'"]')?.focus({preventScroll:true});
if(focusedLibraryTab)el.querySelector('[data-library-tab="'+CSS.escape(focusedLibraryTab)+'"]')?.focus({preventScroll:true});if(focusedSearch){const input=document.getElementById(focusedSearch.id);if(input){input.focus({preventScroll:true});input.setSelectionRange(...searchCaret)}}}
document.addEventListener('click',async e=>{
 if(e.target.hasAttribute('data-saga-modal-backdrop')){sagaCreateOpen=false;render();return}
 const b=e.target.closest('[data-saga-cover-pick],[data-saga-cover-remove],[data-saga-search-clear],[data-saga-cover-save],[data-saga-movie-pick],[data-saga-search],[data-saga-create],[data-saga-add],[data-saga-select],[data-saga-delete],[data-saga-rename],[data-saga-movie-add],[data-saga-modal-close]');if(!b||!user)return;
 try{
 if(b.hasAttribute('data-saga-cover-pick')){const saga=state.sagas?.[sagaSelected];if(!saga)return;saga.coverUrl='';saga.poster_path=b.dataset.sagaCoverPick;await persist();render()}
 else if(b.hasAttribute('data-saga-cover-remove')){const saga=state.sagas?.[sagaSelected];if(!saga)return;delete saga.coverUrl;await persist();render()}
 else if(b.hasAttribute('data-saga-search-clear')){clearTimeout(sagaMovieTimer);sagaMovieSeq++;sagaMovieQuery='';sagaMovieMatches=[];const input=document.getElementById('sagaMovieSearch');if(input){input.value='';input.focus()}document.getElementById('sagaMovieMatches')?.replaceChildren();b.hidden=true}
 else if(b.hasAttribute('data-saga-cover-save')){const saga=state.sagas?.[sagaSelected];if(!saga)return;saga.coverUrl=document.getElementById('sagaCoverUrl')?.value.trim()||'';await persist();render()}
 else if(b.hasAttribute('data-saga-movie-pick')){
  if(b.getAttribute('aria-disabled')==='true')return;
  const movie=sagaMovieMatches.find(movie=>Number(movie.id)===Number(b.dataset.sagaMoviePick));
  if(movie)await addSagaMovie(movie);
 }
 else if(b.hasAttribute('data-saga-search')){sagaQuery=document.getElementById('sagaSearch')?.value.trim()||'';sagaSearching=true;render();sagaMatches=sagaQuery?(await request('/api/collections/search?q='+encodeURIComponent(sagaQuery))).results||[]:[];sagaSearching=false;render()}
 else if(b.hasAttribute('data-saga-create')){sagaCreateOpen=true;render();document.getElementById('sagaNameInput')?.focus()}
 else if(b.hasAttribute('data-saga-modal-close')){sagaCreateOpen=false;render()}else if(b.hasAttribute('data-saga-add')){const id=Number(b.dataset.sagaAdd),item=sagaMatches.find(s=>s.id===id);if(!item)return;const key='tmdb_'+id;state.sagas={...(state.sagas||{}),[key]:{name:item.name,tmdbId:id}};sagaSelected=key;sagaMatches=[];sagaQuery='';await persist();await hydrateSagas();render()}
 else if(b.hasAttribute('data-saga-select')){sagaSelected=b.dataset.sagaSelect;render()}
 else if(b.hasAttribute('data-saga-delete')){if(!await confirmAction('Supprimer cette saga ?','Les films et leurs statuts seront conservés.','Supprimer'))return;delete state.sagas[b.dataset.sagaDelete];sagaSelected='all';await persist();render()}
 else if(b.hasAttribute('data-saga-rename')){const saga=state.sagas?.[b.dataset.sagaRename];if(!saga)return;const name=prompt('Nom de la saga :',saga.name);if(!name?.trim())return;saga.name=name.trim().slice(0,80);await persist();render()}
 else if(b.hasAttribute('data-saga-movie-add')){const saga=state.sagas?.[sagaSelected],id=Number(document.getElementById('sagaMovieId')?.value);if(!saga||!Number.isSafeInteger(id)||id<=0)return;const movie=await request('/api/movie/'+id);filmCache.set(id,movie);saga.movieIds=[...new Set([...(saga.movieIds||[]),id])];await persist();render()}
 }catch(err){sagaSearching=false;error=err.message;render()}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&sagaCreateOpen){sagaCreateOpen=false;render()}});
document.addEventListener('submit',async e=>{if(e.target.id==='sagaCreateForm'){e.preventDefault();const name=document.getElementById('sagaNameInput')?.value.trim();if(!name)return;const id='custom_'+Date.now();state.sagas={...(state.sagas||{}),[id]:{name:name.slice(0,80),movieIds:[],coverUrl:await readSagaCover(document.getElementById('sagaCreateCover')?.files?.[0])}};sagaCreateOpen=false;sagaSelected=id;await persist();render();return}if(e.target.id!=='mqListNameForm')return;e.preventDefault();const name=document.getElementById('listNameInput')?.value.trim();if(!name)return;state.lists=state.lists||{};if(listEditId==='new'){const id='list_'+Date.now();state.lists[id]={name,movieIds:[],tvIds:[],order:sortedLists().length};if(tab==='lists')listSelected=id}else if(state.lists[listEditId])state.lists[listEditId].name=name;listEditId=null;await persist();render()});
let draggedListId=null;
document.addEventListener('dragstart',e=>{const row=e.target.closest('[data-drag-list]');if(!row)return;draggedListId=row.dataset.dragList;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',draggedListId);row.classList.add('is-dragging')});
document.addEventListener('dragover',e=>{const row=e.target.closest('[data-drag-list]');if(row&&draggedListId){e.preventDefault();e.dataTransfer.dropEffect='move'}});
document.addEventListener('drop',async e=>{const row=e.target.closest('[data-drag-list]');if(!row||!draggedListId)return;e.preventDefault();const dest=row.dataset.dragList;if(dest!==draggedListId){const ids=sortedLists().map(l=>l.id),from=ids.indexOf(draggedListId),to=ids.indexOf(dest);if(from>=0&&to>=0){ids.splice(from,1);ids.splice(to,0,draggedListId);ids.forEach((id,i)=>state.lists[id].order=i);await persist();render()}}draggedListId=null});
document.addEventListener('dragend',()=>{draggedListId=null;document.querySelectorAll('.is-dragging').forEach(el=>el.classList.remove('is-dragging'))});
const movieCover=m=>state.movieCovers?.[m.id]||m.poster_path;
function showPosterLightbox(path,title){
 const movieId=Number(film),owner=user;
 const current=filmCache.get(movieId)||{id:movieId,title};
 openMovieGallery({movie:current,selectedPath:path,
  loadImages:async()=>{
   if(current.images)return current.images;
   const images=await request('/api/movie/'+movieId+'/images');
   const latest=filmCache.get(movieId)||current;
   filmCache.set(movieId,{...latest,images});
   return images;
  },
  saveCover:async chosenPath=>{
   if(!owner||user?.uid!==owner.uid)throw Error('Connexion requise');
   await setDoc(doc(db,'users',owner.uid,'data','movieQuest'),{movieCovers:{[movieId]:chosenPath}},{merge:true});
   if(user?.uid===owner.uid)state.movieCovers={...(state.movieCovers||{}),[movieId]:chosenPath};
  },
  onClose:()=>{render()}
 });
}

document.addEventListener('click',e=>{
 const button=e.target.closest('[data-media-page]');
 if(!button||button.disabled)return;
 const key=button.dataset.mediaPage,step=Number(button.dataset.step);
 if(!Object.hasOwn(mediaPages,key)||Math.abs(step)!==1)return;
 mediaPages[key]+=step;
 const id=librarySearchIds[key];
 if(!id){render();return}
 updateFilterResults(id);
 const results=document.getElementById(id+'Results');
 results?.focus({preventScroll:true});
 results?.scrollIntoView({block:'start'});
});
document.addEventListener('click',e=>{const b=e.target.closest('[data-calendar-move],[data-calendar-today]');if(!b)return;if(b.hasAttribute('data-calendar-today'))releaseCalendarOffset=0;else releaseCalendarOffset=Math.max(-120,Math.min(120,releaseCalendarOffset+Number(b.dataset.calendarMove)));render()});
document.addEventListener('click',async e=>{if(e.target.hasAttribute('data-list-modal-backdrop')){closeListModal();return}const b=e.target.closest('button');if(!b)return;try{if(b.hasAttribute('data-zoom-poster')){showPosterLightbox(b.dataset.zoomPoster,b.dataset.posterTitle||'Film')}else if(b.hasAttribute('data-open-list-modal')){listModalSource={id:Number(b.dataset.openListModal),kind:b.dataset.listKind||'movie'};listEditId=null;render();document.querySelector('.mq-list-picker-dialog [data-close-list-modal]')?.focus()}else if(b.hasAttribute('data-close-list-modal')){closeListModal()}else if(b.hasAttribute('data-new-list')){listEditId='new';render();document.getElementById('listNameInput')?.focus()}else if(b.dataset.editList){listEditId=b.dataset.editList;render();document.getElementById('listNameInput')?.focus()}else if(b.hasAttribute('data-cancel-list')){listEditId=null;render()}else if(b.dataset.deleteList){if(!await confirmAction('Supprimer cette liste ?','Les films et séries resteront dans ta collection.','Supprimer'))return;delete state.lists[b.dataset.deleteList];if(listSelected===b.dataset.deleteList)listSelected='all';await persist();render()}else if(b.dataset.toggleMovieSaga){const saga=state.sagas?.[b.dataset.toggleMovieSaga],id=Number(b.dataset.movieId);if(!saga)return;if(b.dataset.listKind==='tv'){await toggleSeriesMembership('sagas',b.dataset.toggleMovieSaga,id)}else{const ids=new Set(saga.movieIds||[]);if(ids.has(id))ids.delete(id);else ids.add(id);saga.movieIds=[...ids];await persist()}render();document.querySelector('[data-toggle-movie-saga="'+CSS.escape(b.dataset.toggleMovieSaga)+'"]')?.focus()}else if(b.dataset.toggleMovieList){const l=state.lists?.[b.dataset.toggleMovieList];if(!l)return;const id=Number(b.dataset.movieId);if(b.dataset.listKind==='tv'){await toggleSeriesMembership('lists',b.dataset.toggleMovieList,id)}else{const ids=new Set(l.movieIds||[]);if(ids.has(id))ids.delete(id);else ids.add(id);l.movieIds=[...ids];await persist()}render();document.querySelector('[data-toggle-movie-list="'+CSS.escape(b.dataset.toggleMovieList)+'"]')?.focus()}else if(b.hasAttribute('data-select-list')){listSelected=b.dataset.selectList;render();await loadRouteContent()}else if(b.dataset.listMedia){listTabMedia=b.dataset.listMedia;render();await loadRouteContent()}else if(b.dataset.listView){listView=b.dataset.listView;setLayout(listView)}else if(b.dataset.seriesOpen){seriesId=Number(b.dataset.seriesOpen);film=null;selected=null;render();await loadSeries(seriesId)}else if(b.dataset.seriesStatus){await changeSeriesStatus(Number(b.dataset.seriesStatus),b.dataset.value)}else if(b.dataset.seasonStatus){await changeSeasonStatus(seriesId,Number(b.dataset.seasonStatus),b.dataset.value==='seen')}else if(b.dataset.seriesSeason){const k=seriesId+':'+b.dataset.seriesSeason;if(expandedSeasons.delete(k)){render()}else await loadSeriesSeason(seriesId,Number(b.dataset.seriesSeason))}else if(b.dataset.seriesEpisode){await toggleEpisode(seriesId,Number(b.dataset.season),Number(b.dataset.episode))}else if(b.dataset.seriesFilter){seriesFilter=b.dataset.seriesFilter;render()}else if(b.dataset.seriesView){setLayout(b.dataset.seriesView)}else if(b.dataset.castFollow){const id=Number(b.dataset.castFollow);await follow(state.following[id]||{id,name:b.dataset.name,role:'actor',profile_path:b.dataset.profile||null});render()}else if(b.dataset.releaseMedia){releaseMediaTab=b.dataset.releaseMedia;render();await loadRouteContent()}else if(b.dataset.watchedMedia){watchedMediaTab=b.dataset.watchedMedia;mediaPages.watched=0;render();await loadRouteContent()}else if(b.dataset.queueMedia){queueMediaTab=b.dataset.queueMedia;mediaPages.queue=0;render();await loadRouteContent()}else if(b.hasAttribute('data-open-suggestion-filters')){saveSuggestionFilterSnapshot();suggestionFiltersOpen=true;render()}else if(b.hasAttribute('data-cancel-suggestion-filters')){closeSuggestionFilters(false)}else if(b.hasAttribute('data-apply-suggestion-filters')){closeSuggestionFilters(true)}else if(b.hasAttribute('data-reset-suggestion-filters')){suggestionGenres=[];suggestionDecades=[];suggestionMinYear=1900;suggestionMaxYear=2030;suggestionRuntime='all';suggestionCountries=[];suggestionPage=0;mediaPages.queue=mediaPages.watched=0;render()}else if(b.dataset.personMedia){personMediaTab=b.dataset.personMedia;personFilmQuery='';render();await loadRouteContent()}else if(b.dataset.exploreSuggestions){exploreSuggestionTab=b.dataset.exploreSuggestions;render();await loadRouteContent()}else if(b.dataset.documentaryPage){documentaryPage+=Number(b.dataset.documentaryPage);render()}else if(b.hasAttribute('data-suggestion-runtime')){suggestionRuntime=b.dataset.suggestionRuntime;mediaPages.queue=mediaPages.watched=0;render();hydrateFilterMetadata()}else if(b.hasAttribute('data-suggestion-country')){const v=b.dataset.suggestionCountry;suggestionCountries=v==='all'?[]:suggestionCountries.includes(v)?suggestionCountries.filter(x=>x!==v):[...suggestionCountries,v];mediaPages.queue=mediaPages.watched=0;render();hydrateFilterMetadata()}else if(b.hasAttribute('data-suggestion-genre')){mediaPages.queue=mediaPages.watched=0;const v=b.dataset.suggestionGenre;suggestionGenres=v==='all'?[]:suggestionGenres.includes(v)?suggestionGenres.filter(x=>x!==v):[...suggestionGenres,v];suggestionPage=0;render()}else if(b.hasAttribute('data-suggestion-decade')){const v=b.dataset.suggestionDecade,y=Number(v);suggestionDecades=v==='all'?[]:suggestionDecades.includes(y)?suggestionDecades.filter(x=>x!==y):[...suggestionDecades,y];suggestionPage=0;mediaPages.queue=mediaPages.watched=0;render()}else if(b.dataset.suggestionPage){suggestionPage+=Number(b.dataset.suggestionPage);render()}else if(b.dataset.clearFilter&&b.dataset.clearFilter==='seriesSearch'){seriesQuery='';seriesResults=[];clearTimeout(seriesSearchTimer);++seriesSearchSeq;render();document.getElementById('seriesSearch')?.focus()}else if(b.dataset.clearFilter){const input=document.getElementById(b.dataset.clearFilter);if(input){input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus()}}else if(b.dataset.castView){setLayout(b.dataset.castView)}else if(b.id==='clearExploreSearch'){query='';results=[];clearTimeout(timer);++searchSeq;render();document.getElementById('search')?.focus()}else if(b.id==='clearFollowingSearch'){followingQuery='';updateFollowingResults();document.getElementById('followingSearch')?.focus()}else if(b.dataset.releaseRole){releaseRole=b.dataset.releaseRole;releasePerson='all';render()}else if(b.dataset.randomKind||b.id==='randomFilm'){const kind=b.dataset.randomKind||'films',items=tab==='queue'?queueFilteredItems():kind==='series'?seriesSuggestions():kind==='documentaries'?docSuggestions():kind==='spectacles'?spectacleSuggestions():suggestions();if(!items.length){error='Aucun résultat disponible.';render()}else{const item=items[Math.floor(Math.random()*items.length)];await openCard({dataset:kind==='series'?{openTv:String(item.id)}:{openFilm:String(item.id)}})}}else if(b.dataset.nowView){setLayout(b.dataset.nowView)}else if(b.dataset.personFilmRole){personFilmRole=b.dataset.personFilmRole;render()}else if(b.dataset.creditPerson){const p={id:Number(b.dataset.creditPerson),name:b.dataset.name,role:b.dataset.role,profile_path:null};currentPerson=p;selected=p.id;film=null;seriesId=null;personFilmRole='all';personMediaTab='films';render();await loadPerson(p)}else if(b.dataset.followingRole){followingRole=b.dataset.followingRole;render()}else if(b.dataset.followingView){setLayout(b.dataset.followingView)}else if(b.dataset.releaseView){setLayout(b.dataset.releaseView)}else if(b.id==='mobileNavToggle'){mobileNavOpen=!mobileNavOpen;menuOpen=false;render();if(mobileNavOpen)mainNavFocus()}else if(b.id==='homeLink'){if(!user)return;mobileNavOpen=false;menuOpen=false;tab='explore';selected=null;film=null;seriesId=null;render();await loadRouteContent()}else if(b.id==='accountToggle'){e.stopPropagation();menuOpen=!menuOpen;render()}else if(b.dataset.accent){if(!user)return;state.preferences={...(state.preferences||{}),accent:b.dataset.accent};applyTheme();await persist();render()}else if(b.id==='saveApi'){const value=document.getElementById('apiOrigin').value.trim();if(value&&!value.startsWith('https://'))throw Error('Une URL HTTPS est nécessaire');localStorage.setItem('moviequest-api-origin',value);location.reload()}else if(b.id==='login')await signInWithPopup(auth,provider);else if(b.id==='logout'){menuOpen=false;await signOut(auth)}else if(b.dataset.tab||b.dataset.libraryTab){
 const target=b.dataset.libraryTab||(isLibraryEntry(b.dataset.tab)?'collections':b.dataset.tab);
 const keepLibraryFocus=Boolean(b.dataset.libraryTab);
 menuOpen=false;
 mobileNavOpen=false;
 applyRoute({tab:target});
 error='';
 render();
 if(keepLibraryFocus)el.querySelector('[data-library-tab][aria-current="page"]')?.focus({preventScroll:true});
 else window.scrollTo({top:0,left:0,behavior:'instant'});
 await loadRouteContent();
}else if(b.dataset.filter){filter=b.dataset.filter;search();render()}else if(b.dataset.follow){const id=Number(b.dataset.follow);const profile=people.get(id)?.profile;const p=state.following[id]||results.find(x=>Number(x.id)===id)||((selected===id||currentPerson?.id===id)?{id,name:profile?.name||currentPerson?.name||'Personnalité',role:currentPerson?.role||'actor',profile_path:profile?.profile_path||currentPerson?.profile_path||null}:null);if(p)await follow(p)}else if(b.dataset.person){selected=Number(b.dataset.person);seriesId=null;film=null;personFilmRole='all';personMediaTab='films';render();scrollToDetailTop();const p=state.following[selected]||knownPeople.get(selected)||results.find(x=>x.id===selected)||currentPerson;if(p){currentPerson=p;await loadPerson(p)}}else if(b.dataset.film){film=Number(b.dataset.film);seriesId=null;selected=null;if(!filmCache.get(film)?.credits){const d=await request('/api/movie/'+film);filmCache.set(film,d)}render()}else if(b.dataset.status)await changeStatus(Number(b.dataset.status),b.dataset.value);else if(b.dataset.dismiss)await dismiss(Number(b.dataset.dismiss));else if(b.dataset.view){setLayout(b.dataset.view)}else if(b.dataset.exploreView){setLayout(b.dataset.exploreView)}else if(b.hasAttribute('data-back')){film=null;selected=null;render()}}catch(e){error=e.message;render()}});
document.addEventListener('click',e=>{if(menuOpen&&!e.composedPath().some(node=>node?.id==='account')){menuOpen=false;render()}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&(menuOpen||mobileNavOpen)){const accountWasOpen=menuOpen;menuOpen=false;mobileNavOpen=false;render();document.getElementById(accountWasOpen?'accountToggle':'mobileNavToggle')?.focus()}});
document.addEventListener('change',async e=>{if(e.target.id==='releaseRole'){releaseRole=e.target.value;releasePerson='all';render();return}if(e.target.id==='releasePerson'){releasePerson=e.target.value;render();return}if(e.target.id==='accentColor'&&user){state.preferences={...(state.preferences||{}),accent:e.target.value};applyTheme();await persist();render()}});function updateFollowingResults(){const matching=followed().filter(p=>(followingRole==='all'||p.role===followingRole)&&p.name.toLocaleLowerCase('fr').includes(followingQuery.trim().toLocaleLowerCase('fr')));const target=document.getElementById('followingResults');if(target)target.innerHTML=personList(matching,followingView);const clear=document.getElementById('clearFollowingSearch');if(clear)clear.hidden=!followingQuery}

document.addEventListener('change',async e=>{if(e.target.matches('[data-tv-episode]')){await toggleEpisode(seriesId,Number(e.target.dataset.tvSeason),Number(e.target.dataset.tvEpisode))}});
document.addEventListener('change',e=>{if(e.target.id==='suggestionMinYear'||e.target.id==='suggestionMaxYear'){mediaPages.queue=mediaPages.watched=0;suggestionPage=0;documentaryPage=0;render()}});
document.addEventListener('change',e=>{if(e.target.id==='watchedSort'){if(watchedMediaTab==='series')watchedSeriesSort=e.target.value;else watchedSort=e.target.value;mediaPages.watched=0;updateFilterResults('watchedSearch')}});
document.addEventListener('input',e=>{const clear=e.target.closest('.search-field')?.querySelector('.search-clear');if(clear)clear.hidden=!e.target.value;if(e.target.id==='sagaMovieSearch'){
 sagaMovieQuery=e.target.value;
 sagaMovieMatches=[];
 const clearButton=document.querySelector('[data-saga-search-clear]');
 if(clearButton)clearButton.hidden=!sagaMovieQuery;
 document.getElementById('sagaMovieMatches')?.replaceChildren();
 clearTimeout(sagaMovieTimer);
 const query=sagaMovieQuery.trim(),seq=++sagaMovieSeq;
 if(query)sagaMovieTimer=setTimeout(()=>searchSagaMovies(query,seq),300);
 return;
}if(e.target.id==='sagaSearch'){sagaQuery=e.target.value;clearTimeout(sagaSearchTimer);sagaSearchSeq++;sagaMatches=[];if(!sagaQuery.trim()){document.getElementById('sagaSearchFeedback')?.replaceChildren();return}sagaSearchTimer=setTimeout(searchSagaCollections,300);return}if(e.target.id==='suggestionMinYear'||e.target.id==='suggestionMaxYear'){if(e.target.id==='suggestionMinYear')suggestionMinYear=Math.min(Number(e.target.value),suggestionMaxYear);else suggestionMaxYear=Math.max(Number(e.target.value),suggestionMinYear);suggestionPage=0;document.getElementById(e.target.id==='suggestionMinYear'?'minYearOutput':'maxYearOutput').textContent=e.target.id==='suggestionMinYear'?suggestionMinYear:suggestionMaxYear;const bar=document.querySelector('.mq-range-selected');if(bar){bar.style.left=((suggestionMinYear-1900)/130*100)+'%';bar.style.right=(100-(suggestionMaxYear-1900)/130*100)+'%'}const counter=document.getElementById('mqFilterResultCount');if(counter)counter.textContent='les '+filteredResultCount()+' résultats';return}if(e.target.id==='listSearch'){listQuery=e.target.value;const target=document.getElementById('listResults');if(target){const all=sortedLists(),chosen=all.find(l=>l.id===listSelected),ids=chosen?(chosen.movieIds||[]):[...new Set(all.flatMap(l=>l.movieIds||[]))],tvIds=chosen?(chosen.tvIds||[]):[...new Set(all.flatMap(l=>l.tvIds||[]))];target.innerHTML=listTabMedia==='series'?seriesList(tvIds.map(id=>seriesCache.get(Number(id))||followedSeries().find(m=>m.id===Number(id))).filter(Boolean).filter(m=>matchesText(m.name,listQuery)),listView):filmList(ids.map(id=>filmCache.get(Number(id))).filter(Boolean).filter(m=>matchesMovieTab(m,listTabMedia)&&matchesText(m.title,listQuery)),listView)}return}if(e.target.id==='seriesSearch'){seriesQuery=e.target.value;clearTimeout(seriesSearchTimer);seriesSearchTimer=setTimeout(searchSeries,350);const clear=e.target.parentElement.querySelector('.search-clear');if(clear)clear.hidden=!seriesQuery;return}if(['personFilmSearch','castSearch','nowSearch','releaseSearch','queueSearch'].includes(e.target.id)){const id=e.target.id;if(id==='personFilmSearch')personFilmQuery=e.target.value;else if(id==='castSearch')castQuery=e.target.value;else if(id==='nowSearch')nowQuery=e.target.value;else if(id==='releaseSearch')releaseQuery=e.target.value;else{queueQuery=e.target.value;mediaPages.queue=0}const clear=e.target.parentElement.querySelector('.search-clear');if(clear)clear.hidden=!e.target.value;updateFilterResults(id);return}if(e.target.id==='personSeriesSearch'){personSeriesQuery=e.target.value;updateFilterResults('personSeriesSearch');return}if(e.target.id==='followingSearch'){followingQuery=e.target.value;updateFollowingResults();return}if(e.target.id==='releasePersonSearch'){releasePerson=e.target.value.trim()||'all';const position=e.target.selectionStart;render();const input=document.getElementById('releasePersonSearch');input?.focus();input?.setSelectionRange(position,position);return}if(e.target.id==='watchedSearch'){watchedQuery=e.target.value;mediaPages.watched=0;updateFilterResults('watchedSearch');return}if(e.target.id==='search'){query=e.target.value;const clear=document.getElementById('clearExploreSearch');if(clear)clear.hidden=!query;clearTimeout(timer);timer=setTimeout(search,350)}});
async function openCard(target){if(!user)return;const scrollToDetailTop=()=>window.scrollTo({top:0,left:0,behavior:'instant'});if(target.dataset.openPerson){personFilmQuery='';selected=Number(target.dataset.openPerson);film=null;seriesId=null;personFilmRole='all';personMediaTab='films';render();const p=state.following[selected]||knownPeople.get(selected)||results.find(x=>x.id===selected)||currentPerson||{id:selected,role:'actor'};currentPerson=p;await loadPerson(p)}else if(target.dataset.openTv){seriesId=Number(target.dataset.openTv);selected=null;film=null;render();scrollToDetailTop();await loadSeries(seriesId);return}if(target.dataset.openFilm){castQuery='';film=Number(target.dataset.openFilm);selected=null;seriesId=null;error='';const pending=loadFilm(film);render();scrollToDetailTop();await pending}}
document.addEventListener('click',async e=>{const calendar=e.target.closest('.mq-calendar-event[data-open-film],.mq-calendar-event[data-open-tv]');if(!calendar)return;e.preventDefault();e.stopImmediatePropagation();try{await openCard(calendar)}catch(err){error=err.message;render()}},true);
document.addEventListener('click',async e=>{if(e.target.closest('button:not(.stat-person-link),a,input,select,label'))return;const card=e.target.closest('[data-open-person],[data-open-film],[data-open-tv]');if(!card)return;try{await openCard(card)}catch(err){error=err.message;render()}});
document.addEventListener('keydown',async e=>{if(!['Enter',' '].includes(e.key)||e.target.closest('button,input,select'))return;const card=e.target.closest('[data-open-person],[data-open-film],[data-open-tv]');if(!card)return;e.preventDefault();try{await openCard(card)}catch(err){error=err.message;render()}});
function mainNavFocus(){document.querySelector('#mainNav button.active')?.focus()}
function applyTheme(){document.documentElement.style.setProperty('--accent',state.preferences?.accent||'#3bdd0e')}
onAuthStateChanged(auth,u=>{
 sectionLoads.clear();
 mediaPages.queue=mediaPages.watched=0;
 pendingRequests.clear();
 personRequests.clear();
 directorDetailPending.clear();
 directorDetailFailed.clear();
 expandedSeasons.clear();
 followedCredits=null;
 authReady=!u;
 user=u;
 menuOpen=false;
 mobileNavOpen=false;
 unsub?.();
 unsub=null;
 state={following:{},statuses:{},dismissed:{},seenAt:{},preferences:{accent:'#3bdd0e'}};
 applyTheme();
 people.clear();
 knownPeople.clear();
 filmCache.clear();
 seriesCache.clear();
 seriesSeasonCache.clear();
 personSeriesCache.clear();
 sagaCache.clear();
 pendingSagaMovies.clear();
 clearTimeout(sagaMovieTimer);
 sagaMovieSeq++;
 sagaMovieQuery='';
 sagaMovieMatches=[];
 if(!u){render();return}
 unsub=onSnapshot(doc(db,'users',u.uid,'data','movieQuest'),snap=>{
  if(user!==u)return;
  if(snap.exists())state={following:{},statuses:{},dismissed:{},seenAt:{},series:{},lists:{},preferences:{accent:'#3bdd0e'},...snap.data()};
  followedCredits=null;
  applyTheme();
  const firstSnapshot=!authReady;
  authReady=true;
  if(!firstSnapshot&&tab==='explore'&&!selected&&!film&&!seriesId){
   document.querySelectorAll('[data-follow]').forEach(button=>updateFollowControls(button.dataset.follow));
   refreshLoadingSection(followingLoadKey(exploreSuggestionTab));
  }else if(!firstSnapshot&&selected)updateFollowControls(selected);
  else render();
  loadRouteContent().catch(e=>{if(user===u){error=e.message;render()}});
 },e=>{error=e.message;authReady=true;render()});
},e=>{error='Impossible de vérifier la session Google : '+e.message;user=null;authReady=true;render()});
