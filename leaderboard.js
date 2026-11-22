/* NORTHSIDE PIZZA V49 - shared daily-sales leaderboard.
 * Public read + anonymous Supabase Auth + server-side RPC writes.
 * Never put a Supabase secret/service-role key into a public website.
 */
(()=>{
'use strict';
const cfg=window.NSP_LEADERBOARD_CONFIG||{};
const base=String(cfg.url||'').trim().replace(/\/+$/,'');
const apiKey=String(cfg.publishableKey||'').trim();
const configured=/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(base)&&/^(sb_publishable_|eyJ)/.test(apiKey);
const NAME_KEY='northside_leaderboard_name_v1';
const SESSION_KEY='northside_leaderboard_auth_v1';
const PENDING_KEY='northside_leaderboard_pending_v1';
const SEED_KEY='northside_leaderboard_seed_v1';
const BOARDS=[['all','🌎 全体'],['lv1_30','LV 1〜30'],['lv31_60','LV 31〜60'],['lv61_90','LV 61〜90'],['lv91_100','LV 91〜100']];
let selectedBoard='all';
let overlay=null;
let priorPaused=false;
let sending=false;
let fetching=false;
let currentRows=[];
let currentRank=null;
let onlineMessage='';
let dataSource='';
let authSession=null;

function read(key, fallback=null){try{let s=localStorage.getItem(key);return s===null?fallback:JSON.parse(s)}catch{return fallback}}
function write(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true}catch{return false}}
function getName(){let n=read(NAME_KEY,'');return typeof n==='string'?n:''}
function saveName(value){return write(NAME_KEY,value)}
function formatYen(v){return '¥'+Math.max(0,Number(v)||0).toLocaleString('ja-JP')}
function bandFor(level){return level<=30?'lv1_30':level<=60?'lv31_60':level<=90?'lv61_90':'lv91_100'}
function normalizeRecord(raw){
  const sales=Number(raw?.sales),lv=Number(raw?.level),day=Number(raw?.day);
  if(!Number.isSafeInteger(sales)||sales<1||sales>9999999)return null;
  if(!Number.isInteger(lv)||lv<1||lv>100)return null;
  if(!Number.isInteger(day)||day<1||day>99999)return null;
  return {sales,level:lv,day};
}
function pending(){const x=read(PENDING_KEY,[]);return Array.isArray(x)?x.map(normalizeRecord).filter(Boolean):[]}
function putPending(record){
  const next=normalizeRecord(record);if(!next)return false;
  let list=pending();const band=bandFor(next.level);
  let before=list.find(x=>bandFor(x.level)===band);
  if(before&&before.sales>=next.sales)return false;
  list=list.filter(x=>bandFor(x.level)!==band);
  list.push(next);
  write(PENDING_KEY,list);return true;
}
function dropPending(record){
  const b=bandFor(record.level);
  write(PENDING_KEY,pending().filter(x=>bandFor(x.level)!==b||x.sales!==record.sales||x.day!==record.day));
}
function readSession(){const s=read(SESSION_KEY);return s?.access_token&&s?.refresh_token&&s?.user?.id?s:null}
async function request(path,{method='GET',data,accessToken}={}){
  if(!configured)throw new Error('オンラインランキングはまだ公開設定されていません');
  const head={'apikey':apiKey,'Accept':'application/json'};
  if(data!==undefined)head['Content-Type']='application/json';
  if(accessToken)head.Authorization='Bearer '+accessToken;
  let response;
  try{
    response=await fetch(base+path,{method,headers:head,...(data!==undefined?{body:JSON.stringify(data)}:{})});
  }catch(e){throw new Error('通信できません。インターネット接続を確認してください')}
  let result=null;
  const body=await response.text();
  if(body){try{result=JSON.parse(body)}catch{result=body}}
  if(!response.ok){
    const msg=result?.msg||result?.message||result?.error_description||result?.error||'通信エラー';
    if(response.status===401||response.status===403)throw new Error('認証に失敗しました。公開者のSupabase設定を確認してください');
    if(response.status===404)throw new Error('データベースの準備が完了していません');
    throw new Error(String(msg).slice(0,160));
  }
  return result;
}
async function auth(){
  if(authSession?.expires_at && authSession.expires_at*1000>Date.now()+60000)return authSession;
  const old=readSession();
  if(old?.expires_at && old.expires_at*1000>Date.now()+60000){authSession=old;return old}
  if(old?.refresh_token){
    try{
      const refreshed=await request('/auth/v1/token?grant_type=refresh_token',{method:'POST',data:{refresh_token:old.refresh_token}});
      if(refreshed?.access_token&&refreshed?.user?.id){authSession=refreshed;write(SESSION_KEY,refreshed);return refreshed}
    }catch(e){
      if(String(e.message).includes('通信できません'))throw e;
      authSession=null;write(SESSION_KEY,null);
    }
  }
  const newUser=await request('/auth/v1/signup',{method:'POST',data:{data:{}}});
  if(!newUser?.access_token||!newUser?.user?.id)throw new Error('匿名ログインできません。Supabaseで匿名サインインを有効にしてください');
  authSession=newUser;write(SESSION_KEY,newUser);
  return newUser;
}
function status(message,cls=''){
  onlineMessage=message;
  const el=overlay?.querySelector('#nsLbStatus');
  if(el){el.textContent=message;el.className='ns-lb-status '+cls}
}
function seedExistingBest(){
  const best=typeof dailyBest==='function'?Number(dailyBest()):0;
  if(!best||!Number.isSafeInteger(best))return;
  let item=(Array.isArray(career?.topDays)?career.topDays:[]).find(x=>Number(x.sales)===best);
  if(!item)item=(Array.isArray(career?.history)?career.history:[]).find(x=>Number(x.sales)===best);
  const record={sales:best,level:Math.min(100,Math.max(1,Number(item?.level)||level())),day:Number(item?.day)||Math.max(1,Number(career?.day)-1)};
  const fingerprint=[best,record.level,record.day].join(':');
  if(read(SEED_KEY,'')!==fingerprint){putPending(record);write(SEED_KEY,fingerprint)}
}
function snapshotDay(){
  const entry=Array.isArray(career?.history)?career.history[0]:null;
  if(!entry)return;
  // The server ranks actual completed-day revenue (including branches).
  const record=normalizeRecord({sales:entry.sales,level:level(),day:entry.day});
  if(!record)return;
  putPending(record);
  if(configured&&getName())void sendPending(false);
}
async function sendPending(verbose=true){
  if(sending)return;
  if(!configured||!getName())return;
  const items=pending();
  if(!items.length){if(verbose)status('送信待ちの記録はありません。新しい営業日で記録に挑戦！');return}
  sending=true;
  if(verbose)status('最高日商を送信中…');
  let sent=0;
  try{
    const user=await auth();
    for(const rec of items){
      await request('/rest/v1/rpc/northside_submit_score',{method:'POST',accessToken:user.access_token,
        data:{p_nickname:getName(),p_sales:rec.sales,p_level:rec.level,p_day:rec.day}});
      dropPending(rec);sent++;
    }
    status('✅ '+sent+' 件の記録をランキングに送信しました','ok');
  }catch(e){status('⚠️ '+e.message+'（記録は端末に保管中）','error')}
  finally{sending=false}
}
async function loadBoard(){
  if(!overlay||overlay.hidden||fetching)return;
  if(!configured){renderNoConfig();return}
  fetching=true;
  const b=selectedBoard;
  const listEl=overlay.querySelector('#nsLbRows');
  if(listEl)listEl.textContent='ランキングを読み込み中…';
  try{
    const query=`?select=player_id,nickname,sales,level,day&board=eq.${b}&order=sales.desc,updated_at.asc&limit=50`;
    const rows=await request('/rest/v1/northside_records'+query);
    if(!Array.isArray(rows))throw new Error('ランキングのデータ形式が正しくありません');
    currentRows=rows;dataSource='live';write('northside_rankcache_'+b,rows);
    currentRank=null;
    const s=readSession();
    if(s&&getName()){
      try{
        const a=await auth();
        currentRank=await request('/rest/v1/rpc/northside_my_rank',{method:'POST',accessToken:a.access_token,data:{p_board:b}});
      }catch(e){currentRank=null}
    }
    renderRows();
  }catch(e){
    const cached=read('northside_rankcache_'+b,[]);
    currentRows=Array.isArray(cached)?cached:[];dataSource=currentRows.length?'cache':'failed';currentRank=null;
    renderRows();
    status('⚠️ '+e.message+(dataSource==='cache'?'（以前のランキングを表示）':''),'error');
  }finally{fetching=false}
}
function rowElement(r,i,userId){
  const row=document.createElement('div');row.className='ns-lb-row'+(r.player_id===userId?' ns-lb-mine':'');
  const pos=document.createElement('span');pos.className='ns-lb-pos';pos.textContent=i===0?'🥇':i===1?'🥈':i===2?'🥉':'#'+(i+1);
  const info=document.createElement('div');info.className='ns-lb-person';
  const name=document.createElement('strong');name.textContent=String(r.nickname||'ピザ職人').slice(0,20);
  const sub=document.createElement('small');sub.textContent='LV '+Number(r.level)+'  ·  DAY '+Number(r.day);
  info.append(name,sub);
  const cash=document.createElement('b');cash.className='ns-lb-cash';cash.textContent=formatYen(r.sales);
  row.append(pos,info,cash);return row;
}
function renderRows(){
  if(!overlay)return;
  const target=overlay.querySelector('#nsLbRows');target.replaceChildren();
  const userId=readSession()?.user?.id;
  const me=overlay.querySelector('#nsLbMe');
  me.textContent=currentRank!==null&&Number.isFinite(Number(currentRank))?'あなたの順位：'+Number(currentRank)+' 位':'この部門はまだ未投稿';
  if(dataSource==='cache')me.textContent+='　・　前回の表示';
  if(dataSource==='failed'){
    target.textContent='まだランキングを表示できません。ネット接続か公開設定を確認してね。';return;
  }
  if(!currentRows.length){target.textContent='まだ記録がありません。一番乗りを狙おう！';return}
  currentRows.forEach((r,i)=>target.appendChild(rowElement(r,i,userId)));
}
function renderNoConfig(){
  const target=overlay?.querySelector('#nsLbRows');if(!target)return;
  target.textContent='ランキング公開の準備中です。ゲームは今までどおり遊べます。';
  overlay.querySelector('#nsLbMe').textContent='サーバー未接続';
  status('公開者がSupabaseのURL・Publishable keyを設定するとオンラインで競えます');
}
function setTab(board){
  selectedBoard=board;
  overlay.querySelectorAll('[data-ns-board]').forEach(b=>{const yes=b.dataset.nsBoard===board;b.classList.toggle('sel',yes);b.setAttribute('aria-selected',String(yes))});
  currentRows=[];currentRank=null;dataSource='';
  void loadBoard();
}
function show(){
  if(overlay&&!overlay.hidden)return;
  priorPaused=!!S.paused;
  S.paused=true;
  overlay.hidden=false;
  overlay.querySelector('#nsLbName').value=getName();
  overlay.querySelector('#nsLbConsent').textContent=getName()?'登録名を変えると、以後の記録も新しい名前で表示されます。':'名前を保存すると、以後の最高日商を営業終了後に自動投稿します。';
  overlay.querySelector('#nsLbPending').textContent=pending().length?'📤 投稿待ち '+pending().length+' 件':'';
  status(configured?'ランキングにつないでいます…':'ランキング接続の準備中');
  setTab(selectedBoard);
  if(configured&&getName())void sendPending(false).then(()=>{if(!overlay.hidden)void loadBoard()});
}
function hide(){overlay.hidden=true;S.paused=priorPaused}
function saveAndPost(){
  const name=overlay.querySelector('#nsLbName').value.trim();
  if(!name||name.length>16||/[\x00-\x1f\x7f]/.test(name)){status('ニックネームを1〜16文字で入力してください','error');return}
  saveName(name);overlay.querySelector('#nsLbConsent').textContent='✅ 以後の営業記録は自動的に投稿されます。';
  seedExistingBest();
  overlay.querySelector('#nsLbPending').textContent=pending().length?'📤 投稿待ち '+pending().length+' 件':'';
  if(!configured){status('名前と記録を保存しました。サーバーの接続後に投稿できます');return}
  void sendPending(true).then(()=>{if(!overlay.hidden)void refresh()});
}
async function refresh(){
  if(!overlay||overlay.hidden)return;
  if(configured&&!sending&&getName()&&pending().length)await sendPending(true);
  await loadBoard();
  if(overlay&&!overlay.hidden)overlay.querySelector('#nsLbPending').textContent=pending().length?'📤 投稿待ち '+pending().length+' 件':'';
}
function initOverlay(){
  if(overlay)return;
  overlay=document.createElement('div');overlay.id='nsOnlineOverlay';overlay.className='ns-online-overlay';overlay.hidden=true;
  overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','みんなの最高日商ランキング');
  overlay.innerHTML=`<section class="ns-lb-panel">
    <div class="ns-lb-head"><div><small>WORLDWIDE PIZZA CHALLENGE</small><h2>🏆 みんなの最高日商</h2></div><button type="button" id="nsLbClose" aria-label="閉じる">✕</button></div>
    <div class="ns-lb-form"><label for="nsLbName">ランキングに表示する名前（16文字まで）</label>
      <div class="ns-lb-name-row"><input id="nsLbName" maxlength="16" autocomplete="off" placeholder="例：ピザ名人" aria-label="ニックネーム"><button id="nsLbSave">記録を投稿</button></div>
      <small id="nsLbConsent">名前を登録すると、以後の最高日商は自動で投稿されます。</small>
      <span id="nsLbPending" class="ns-lb-pending"></span></div>
    <div id="nsLbStatus" class="ns-lb-status" aria-live="polite"></div>
    <div class="ns-lb-tabs" role="tablist" aria-label="ランキング部門">${BOARDS.map(([key,title])=>`<button type="button" role="tab" data-ns-board="${key}" ${key==='all'?'class="sel" aria-selected="true"':'aria-selected="false"'}>${title}</button>`).join('')}</div>
    <div id="nsLbMe" class="ns-lb-me">この部門はまだ未投稿</div>
    <div id="nsLbRows" class="ns-lb-rows">読み込み中…</div>
    <button id="nsLbRefresh" class="ns-lb-refresh" type="button">🔄 ランキングを更新</button>
    <p class="ns-lb-note">順位は日商で決まります。各プレイヤーにつき各部門の最高記録1件を表示。<br>端末ごとに匿名認証されるため、別端末への順位引き継ぎには対応していません。オフライン中は投稿を保留します。<br>※簡易ランキングのため、改造による不正記録は完全には防げません。</p>
  </section>`;
  document.getElementById('app').appendChild(overlay);
  overlay.querySelector('#nsLbClose').onclick=hide;
  overlay.querySelector('#nsLbSave').onclick=saveAndPost;
  overlay.querySelector('#nsLbRefresh').onclick=()=>void refresh();
  overlay.querySelectorAll('[data-ns-board]').forEach(b=>b.onclick=()=>setTab(b.dataset.nsBoard));
}
function addButton(parent,kind){
  if(!parent||parent.querySelector('[data-ns-open]'))return;
  const b=document.createElement('button');b.type='button';b.dataset.nsOpen=kind;b.className='ns-lb-entry '+kind;
  b.textContent='🌎 みんなの最高日商ランキング';b.onclick=show;
  if(kind==='start'){
    const secondary=parent.querySelector('.start-secondary-actions');
    if(secondary)parent.insertBefore(b,secondary);else parent.appendChild(b);
  }else if(kind==='manage'){
    const resume=parent.querySelector('#resume,#manageNextDayBottom,#openSaveManager');
    if(resume)resume.insertAdjacentElement('beforebegin',b);else parent.appendChild(b);
  }else{
    const next=parent.querySelector('#next');
    if(next)next.insertAdjacentElement('afterend',b);else parent.appendChild(b);
  }
}
function addLaunch(){addButton(document.querySelector('#startButtons'),'start')}
function addManage(){const s=document.querySelector('#sheet');if(s?.querySelector('.manage-title'))addButton(s,'manage')}
function addClosing(){const s=document.querySelector('#sheet');if(s?.querySelector('#next'))addButton(s,'closing')}
function patchGame(){
  const oldOpening=openingMenu;
  openingMenu=function(...args){const out=oldOpening.apply(this,args);addLaunch();return out};
  const oldManage=manage;
  manage=function(...args){const out=oldManage.apply(this,args);addManage();return out};
  const oldEnd=endDay;
  endDay=function(...args){const before=career.day;const out=oldEnd.apply(this,args);
    const entry=Array.isArray(career.history)?career.history[0]:null;
    if(entry&&entry.day===before)snapshotDay();
    addClosing();return out};
  addLaunch();addManage();addClosing();
}
initOverlay();patchGame();
window.northsideLeaderboard={open:show,refresh,configured,queue:putPending,seed:seedExistingBest};
})();
