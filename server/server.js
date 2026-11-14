const fs=require('fs');
const path=require('path');
const WebSocket=require('ws');
const http=require('http');
const crypto=require('crypto');
const DATA_FILE=process.env.PV_DATA_FILE||path.join(__dirname,'accounts.json');
let db={users:{},scores:{}};
try{db=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))}catch{}
db.users ||= {};db.scores ||= {};
const tokens=new Map();
const challenges=new Map();
const challengeRate=new Map();
function makeQuestion(){
 const a=2+crypto.randomInt(19),b=2+crypto.randomInt(19);
 const op=crypto.randomInt(3);
 return {question:op===0?`${a} + ${b}`:op===1?`${a+b} - ${a}`:`${a} × ${b}`,answer:op===0?a+b:op===1?b:a*b};
}
function publicChallenge(ch){return {question:ch.question,remaining:Math.max(0,Math.ceil((ch.expires-Date.now())/1000)),score:ch.score,answered:ch.answered}}

function persist(){const tmp=DATA_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db));fs.renameSync(tmp,DATA_FILE)}
function reply(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
function userFor(req){const token=(req.headers.authorization||'').replace(/^Bearer /,'');return tokens.get(token)}
function hash(password,salt){return crypto.scryptSync(password,salt,64).toString('hex')}
function clean(s){return String(s||'').trim().replace(/[^a-zA-Z0-9_-]/g,'').slice(0,18)}
function tokenFor(username){const token=crypto.randomBytes(32).toString('hex');tokens.set(token,username);return token}
async function api(req,res){
 if(req.method==='OPTIONS')return reply(res,200,{ok:true});
 if(req.method==='GET'&&req.url==='/api/leaderboard'){const scores=Object.entries(db.scores).flatMap(([username,games])=>Object.entries(games).map(([game,score])=>({username,game,score}))).sort((a,b)=>b.score-a.score).slice(0,30);return reply(res,200,{scores})}
 if(req.method==='GET'&&req.url==='/api/friends'){const username=userFor(req);if(!username)return reply(res,401,{error:'Log in first.'});const u=db.users[username];return reply(res,200,{friends:u.friends||[],incoming:u.incoming||[],outgoing:u.outgoing||[]})}
 if(req.method!=='POST')return reply(res,404,{error:'Not found'});
 let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096)return reply(res,413,{error:'Request too large'})}
 let body;try{body=JSON.parse(raw)}catch{return reply(res,400,{error:'Invalid JSON'})}
 const username=clean(body.username),password=String(body.password||'');
 if(req.url==='/api/register'){
  if(username.length<3||password.length<8)return reply(res,400,{error:'Username needs 3+ letters; password needs 8+ characters.'});
  if(db.users[username])return reply(res,409,{error:'Username already taken.'});
  const salt=crypto.randomBytes(16).toString('hex');
  db.users[username]={salt,passwordHash:hash(password,salt),friends:[],incoming:[],outgoing:[]};persist();
  return reply(res,200,{username,token:tokenFor(username)})
 }
 if(req.url==='/api/login'){
  const u=db.users[username];if(!u||!u.passwordHash||!crypto.timingSafeEqual(Buffer.from(u.passwordHash,'hex'),Buffer.from(hash(password,u.salt),'hex')))return reply(res,401,{error:'Invalid username or password.'});
  return reply(res,200,{username,token:tokenFor(username)})
 }
 const me=userFor(req);if(!me)return reply(res,401,{error:'Log in first.'});
 if(req.url==='/api/score'){
  return reply(res,403,{error:'Unverified client scores are local-only. Play Verified Math Sprint to earn online leaderboard scores.'})
 }
 if(req.url==='/api/challenge/start'){
  const now=Date.now(),prior=challengeRate.get(me)||0;
  if(now-prior<10000)return reply(res,429,{error:'Wait 10 seconds before starting another ranked round.'});
  challengeRate.set(me,now);
  const q=makeQuestion();
  const ch={...q,score:0,answered:0,expires:now+60000,created:now,used:false};
  challenges.set(me,ch);
  return reply(res,200,{...publicChallenge(ch),game:'verified-math'})
 }
 if(req.url==='/api/challenge/answer'){
  const ch=challenges.get(me);
  if(!ch)return reply(res,400,{error:'Start a ranked round first.'});
  const now=Date.now();
  if(now>=ch.expires){
   challenges.delete(me);
   db.scores[me] ||= {};
   db.scores[me]['verified-math']=Math.max(db.scores[me]['verified-math']||0,ch.score);
   persist();
   return reply(res,200,{finished:true,score:ch.score,best:db.scores[me]['verified-math']});
  }
  const answer=body.answer;
  if(typeof answer!=='number'||!Number.isSafeInteger(answer))return reply(res,400,{error:'Submit a whole-number answer.'});
  if(ch.used)return reply(res,429,{error:'Please wait for the next question.'});
  ch.used=true;
  const correct=answer===ch.answer;
  if(correct)ch.score+=10;
  ch.answered++;
  const q=makeQuestion();ch.question=q.question;ch.answer=q.answer;ch.used=false;
  return reply(res,200,{...publicChallenge(ch),correct})
 }
 if(req.url==='/api/challenge/finish'){
  const ch=challenges.get(me);
  if(!ch)return reply(res,400,{error:'No ranked round running.'});
  if(Date.now()<ch.expires)return reply(res,400,{error:'Ranked round still in progress.'});
  challenges.delete(me);
  db.scores[me] ||= {};
  db.scores[me]['verified-math']=Math.max(db.scores[me]['verified-math']||0,ch.score);
  persist();
  return reply(res,200,{finished:true,score:ch.score,best:db.scores[me]['verified-math']})
 }
 if(req.url==='/api/friends/request'){
  if(!username||!db.users[username]||username===me)return reply(res,400,{error:'Choose another existing username.'});
  const target=db.users[username],sender=db.users[me];
  if(sender.friends.includes(username))return reply(res,400,{error:'Already friends'});
  if(!target.incoming.includes(me))target.incoming.push(me);
  if(!sender.outgoing.includes(username))sender.outgoing.push(username);
  persist();return reply(res,200,{ok:true})
 }
 if(req.url==='/api/friends/accept'){
  const target=db.users[me],sender=db.users[username];
  if(!sender||!target.incoming.includes(username))return reply(res,400,{error:'No request from that player.'});
  target.incoming=target.incoming.filter(v=>v!==username);sender.outgoing=sender.outgoing.filter(v=>v!==me);
  if(!target.friends.includes(username))target.friends.push(username);
  if(!sender.friends.includes(me))sender.friends.push(me);
  persist();return reply(res,200,{ok:true})
 }
 return reply(res,404,{error:'Unknown action'})
}

const server=http.createServer((req,res)=>{if(req.url.startsWith('/api/')){api(req,res).catch(()=>reply(res,500,{error:'Server error'}));return}res.writeHead(200,{'Content-Type':'text/html'});fs.createReadStream(path.join(__dirname,'../index.html')).pipe(res)
const rooms=new Map();
function send(ws,msg){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg))}
function broadcast(room){const members=rooms.get(room);if(!members)return;const players=[...members].map(c=>({name:c.name,color:c.color,x:c.x,y:c.y}));for(const c of members)send(c,{type:'state',players})}
function leave(ws){if(!ws.room)return;const room=ws.room;const members=rooms.get(room);if(members){members.delete(ws);if(!members.size)rooms.delete(room);else broadcast(room)}ws.room=null}
wss.on('connection',ws=>{
 ws.on('message',raw=>{
  if(raw.length>2048)return;
  let msg;try{msg=JSON.parse(raw)}catch{return}
  if(msg.type==='join'){
   const room=String(msg.room||'').replace(/[^A-Z0-9_-]/gi,'').slice(0,16).toUpperCase();
   if(!room){send(ws,{type:'error',message:'Room code required'});return}
   leave(ws);
   if(!rooms.has(room))rooms.set(room,new Set());
   if(rooms.get(room).size>=16){send(ws,{type:'error',message:'Room is full'});return}
   ws.room=room;ws.name=String(msg.name||'Player').slice(0,18);ws.color=/^#[0-9a-f]{6}$/i.test(msg.color)?msg.color:'#64f5df';ws.x=100+Math.random()*400;ws.y=100+Math.random()*200;rooms.get(room).add(ws);broadcast(room);
  }else if(msg.type==='move'&&ws.room){
   const x=Number(msg.x),y=Number(msg.y);
   if(Number.isFinite(x)&&Number.isFinite(y)){ws.x=Math.max(20,Math.min(680,x));ws.y=Math.max(20,Math.min(420,y));broadcast(ws.room)}
  }
 });
 ws.on('close',()=>leave(ws));
});
const PORT=Number(process.env.PORT)||3000;
server.listen(PORT,'0.0.0.0',()=>console.log('Pixelverse server listening on port '+PORT));
