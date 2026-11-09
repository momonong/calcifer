const $=id=>document.getElementById(id),API='/calcifer/api/';
const labels={work:'工作',resume:'接續目標',test:'相關測試',export:'產生 patch',recover:'核對結果',authorize:'資源批准',abandon:'放棄目標',queued:'排隊中',running:'執行中',cancel_requested:'正在要求停止',unknown:'結果未知',completed:'已完成',failed:'未完成',rejected:'未批准',cancelled:'已取消',ready:'可接續',unavailable:'主機工作階段無法讀取'};
const messages={AUTHORIZATION_REQUIRED:'此專案尚未批准模型資源，請展開「模型、資源與工作範圍」確認。',RESOURCE_LIMIT:'本階段資源已用完，請核對範圍後批准下一階段。',GOAL_REQUIRES_RESUME:'原請求已核對，整體目標尚未完成；請明確接續目標。',LOCAL_OPERATION_INTERRUPTED:'本機操作中斷，未宣稱完成；已保留既有檔案。',OPERATION_NOT_STARTED:'原生操作尚未開始，沒有重新派送。',AUTH_REQUIRED:'登入已到期，請重新登入。工作會在主機繼續。',LOGIN_FAILED:'密碼不正確，請重新輸入。',LOGIN_RATE_LIMIT:'登入嘗試過於頻繁，請稍候一分鐘。',AUTHORIZATION_SCOPE_CHANGED:'模型或資料範圍已變動，請重新核對後再批准。',PROJECT_UNKNOWN:'此專案有結果未知的工作，請先核對原始結果。',PROJECT_BUSY:'工作佇列已滿，請等待目前工作。',CSRF_REJECTED:'登入狀態已變動，請重新登入。',COMMAND_CONFLICT:'此命令編號已對應其他內容；未重送工作。',PATCH_CHANGED_OR_UNSAFE:'patch 已變動或無法安全讀取，請重新產生。',BUDGET_EXHAUSTED:'本階段模型呼叫已用完，請核對後批准新階段。',NOT_AUTHORIZED:'此專案尚未批准模型資源。'};
let session=null,snapshot=null,stream=null,selected='',refreshing=null,refreshAgain=false,approvalHash=null,online=false,receiptMissing=false;
let pending=null;try{pending=JSON.parse(sessionStorage.getItem('calcifer.pending')??'null');}catch{}
const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
function notice(message){$('notice').textContent=message??'';$('notice').hidden=!message;}
function pendingSave(value){pending=value;receiptMissing=false;try{if(value)sessionStorage.setItem('calcifer.pending',JSON.stringify(value));else sessionStorage.removeItem('calcifer.pending');}catch{}}
function showLogin(error=''){session=null;stream?.close();stream=null;online=false;$('workspace').hidden=true;$('login').hidden=false;$('login-error').textContent=error;}
async function request(path,{method='GET',body}={}){
 let response;try{response=await fetch(API+path,{method,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json',...(session?{'X-CSRF-Token':session.csrf}:{})}:{},...(body?{body:JSON.stringify(body)}:{})});}catch{throw Object.assign(Error('無法連到主機；不會自動重送。'),{uncertain:true});}
 let value;try{value=await response.json();}catch{throw Object.assign(Error('主機回覆不完整；不會自動重送。'),{uncertain:true});}
 if(!response.ok){const e=Object.assign(Error(messages[value.error]??value.error??'主機回覆錯誤'),{status:response.status,uncertain:response.status>=500});if(response.status===401&&path!=='login')showLogin(e.message);throw e;}return value;
}
function current(){return snapshot?.projects.find(p=>p.id===selected);}
function describeScope(parent,s){
 parent.replaceChildren();if(!s){parent.append(node('p','工作範圍尚未載入。'));return;}
 const models=s.routing?.profiles?.filter(p=>p.enabled).map(p=>`${p.id} · ${p.execution.backend} / ${p.execution.model} / ${p.execution.effort}；${p.resource}，最多 ${p.maxCalls} 次`)??[`${s.backend??s.execution?.backend??'未指定'} / ${s.model??s.execution?.model??'未指定'} / ${s.execution?.effort??'未指定'}`];
 parent.append(node('p',s.routing?'依任務選模；規劃設定：'+s.routing.planner:'固定模型設定'));const ul=node('ul');for(const m of models)ul.append(node('li',m));parent.append(ul);
 parent.append(node('p',`本階段呼叫：${s.turnsUsed??0} / ${s.maxTurns??0}。${!s.maxTurns?'尚未批准。':s.maxMinutes===null?'不設整體執行期限。':`上限 ${s.maxMinutes} 分鐘；${s.deadlineAt??'首次派送後計時'}。`}`));
 parent.append(node('p','傳送資料：所選隔離專案的必要程式、適用規則、需求與允許的合成資料。'));
 if(s.profile){parent.append(node('p','來源檔案：'+(s.profile.sourceFiles??[]).join('、')));parent.append(node('p','允許修改：'+(s.profile.writeRules??[]).map(r=>typeof r==='string'?r:JSON.stringify(r)).join('、')));}
 for(const a of s.goal?.assignments??[])parent.append(node('p',`${a.taskId} → ${a.execution?.model??'待選'} / ${a.execution?.effort??''} · ${a.plannerReason??''}`));
}
function render(){
 if(!snapshot)return;$('project').replaceChildren(...snapshot.projects.map(p=>{const o=node('option',p.label);o.value=p.id;return o;}));
 if(!snapshot.projects.some(p=>p.id===selected))selected=snapshot.projects[0]?.id??'';$('project').value=selected;
 const p=current(),s=p?.status??{},commands=snapshot.commands.filter(c=>c.project===selected),active=commands.some(c=>['running','queued','cancel_requested'].includes(c.status)),unknown=commands.some(c=>c.status==='unknown')||(s.pending&&!active);
 $('project-name').textContent=p?.label??'尚未登錄專案';$('host').textContent=snapshot.hostLabel??'開發主機';
 $('project-status').textContent=`${labels[s.status]??s.status??'讀取中'} · 呼叫 ${s.turnsUsed??0} / ${s.maxTurns??0} · ${s.maxTurns?(s.maxMinutes===null?'不設執行期限':`上限 ${s.maxMinutes} 分鐘`):'尚未批准資源'}`;
 describeScope($('scope-content'),s);const list=$('transcript');list.replaceChildren();
 if(!commands.length){if(s.lastTask){const article=node('article',undefined,'entry');article.append(node('p','主機上既有的上一段工作','entry-meta'),node('p',s.lastTask.task??'','task'),node('div',s.lastTask.response??'尚無回覆','response'));list.append(article);}else{const e=node('div',undefined,'empty');e.append(node('strong','從一個明確的目標開始。'),node('p','交代需求與完成條件，或先執行相關測試。工作進度會同步到你登入的其他裝置。'));list.append(e);}}
 for(const c of commands){
  const article=node('article',undefined,'entry');article.dataset.commandId=c.id;const meta=node('div',undefined,'entry-meta');meta.append(node('strong',labels[c.action]??c.action),node('span',labels[c.status]??c.status,'state '+c.status),node('time',new Date(c.createdAt).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})));article.append(meta);
  if(c.input.task)article.append(node('p',c.input.task,'task'));
  const text=c.result?.response;if(text)article.append(node('div',text,'response'));
  if(c.error||c.result?.code)article.append(node('p',messages[c.error??c.result.code]??(c.error??c.result.code),'subtle'));
  if(c.status==='unknown')article.append(node('p','主機保留原始收據。請先核對結果，不會自動重送這件工作。','subtle'));
  if(c.result?.cancellation){const detail=node('details'),summary=node('summary','停止狀態');detail.append(summary,node('pre',JSON.stringify(c.result.cancellation,null,2)));article.append(detail);}
  for(const check of c.result?.checks??[]){const detail=node('details');detail.append(node('summary',`${check.stage??'測試'} · ${labels[check.status]??check.status}`),node('pre',(check.stdout??'')+'\n'+(check.stderr??'')));article.append(detail);}
  if(['running','queued','cancel_requested'].includes(c.status)){const b=node('button',c.status==='cancel_requested'?'已要求停止':c.status==='queued'?'取消排隊':'要求停止','danger');b.type='button';b.disabled=c.status==='cancel_requested';b.onclick=()=>stop(c.id,b);article.append(b);}
  if(c.hasPatch){const a=node('a','下載已驗證的 patch','download');a.href=API+'commands/'+c.id+'/patch';a.download='';article.append(a);}
  list.append(article);
 }
 $('compose-hint').textContent=unknown?'結果未知，先核對後才能接續。':pending?'正在核對上一筆送出收據；不會重送。':active?'下一件工作會排隊，等本次結束後處理。':'沿用此專案的模型授權；用完後需另外批准。';
 $('send').textContent=active?'加入佇列':'送出工作';$('send').disabled=!online||!selected||Boolean(pending)||Boolean(unknown);
 for(const b of document.querySelectorAll('[data-action]'))b.disabled=!online||!selected||Boolean(pending)||(Boolean(unknown)&&b.dataset.action!=='recover');
 $('resume').hidden=!s.goal||s.goal.status==='completed';$('authorize').disabled=!online||active||Boolean(unknown)||Boolean(pending)||!s.scopeHash;
 $('retry-pending').hidden=!(receiptMissing&&pending?.input);$('retry-pending').disabled=!online;
}
async function refresh(){
 if(refreshing){refreshAgain=true;return refreshing;}
 refreshing=(async()=>{try{snapshot=await request('snapshot');online=true;if(pending){try{await request('commands/'+pending.id);pendingSave(null);notice('已核對送出收據；未重複執行。');}catch(e){if(e.status===404){receiptMissing=true;notice('主機尚未找到這筆收據：'+pending.id+'。你可以明確選擇以原編號、原內容重送；主機會避免重複執行。');}else throw e;}}render();}catch(e){online=false;notice(e.message);render();}finally{refreshing=null;if(refreshAgain){refreshAgain=false;setTimeout(()=>void refresh(),150);}}})();return refreshing;
}
function connect(){stream?.close();stream=new EventSource(API+'events?after='+(snapshot?.cursor??0));stream.onopen=()=>{online=true;$('connection').textContent='已連線';void refresh();};stream.addEventListener('update',()=>void refresh());stream.onerror=()=>{online=false;$('connection').textContent='連線中斷 · 正在重連';render();};}
async function enter(s){session=s;$('password').value='';$('login').hidden=true;$('workspace').hidden=false;await refresh();if(session)connect();}
async function submit(action,input={}){
 if(pending){notice('上一筆送出結果仍待核對。');return null;}const c={id:crypto.randomUUID(),project:selected,action,input};pendingSave(c);render();
 try{const receipt=await request('commands',{method:'POST',body:c});pendingSave(null);notice(null);await refresh();return receipt;}catch(e){if(!e.uncertain)pendingSave(null);notice(e.message+(e.uncertain?' 命令編號：'+c.id:''));render();return null;}
}
async function retryPending(){
 const c=pending;if(!c?.input||!receiptMissing)return;$('retry-pending').disabled=true;
 try{try{await request('commands/'+c.id);pendingSave(null);notice('原工作已存在，未重送。');await refresh();return;}catch(e){if(e.status!==404)throw e;}
  await request('commands',{method:'POST',body:c});pendingSave(null);notice('已沿用原編號送出，沒有建立另一件工作。');await refresh();
 }catch(e){notice(e.message);render();}
}
async function stop(id,button){button.disabled=true;try{await request('commands/'+id+'/cancel',{method:'POST',body:{}});notice('已要求停止。這不代表遠端推論已停止，請查看工作回報。');await refresh();}catch(e){notice(e.message);button.disabled=false;}}
async function logout(all){try{await request(all?'logout-all':'logout',{method:'POST',body:{}});showLogin('已登出。主機工作仍會繼續。');}catch(e){notice(e.message);}}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter??$('login-form').querySelector('button[type=submit]');b.disabled=true;$('login-error').textContent='正在登入…';try{await enter(await request('login',{method:'POST',body:{password:$('password').value,device:$('device').value}}));}catch(error){$('password').value='';$('login-error').textContent=error.message;}finally{b.disabled=false;}});
$('project').addEventListener('change',()=>{selected=$('project').value;notice(null);render();});$('refresh').onclick=()=>void refresh();$('logout').onclick=()=>void logout(false);$('logout-all').onclick=()=>void logout(true);
$('retry-pending').onclick=()=>void retryPending();
$('composer').addEventListener('submit',async e=>{e.preventDefault();const task=$('task').value.trim();if(!task||$('send').disabled)return;const receipt=await submit('work',{task});if(receipt)$('task').value='';});
for(const b of document.querySelectorAll('[data-action]'))b.onclick=()=>void submit(b.dataset.action);
$('authorize').onclick=()=>{const s=current()?.status;approvalHash=s?.scopeHash;describeScope($('approval-scope'),s);$('approval').showModal();};$('approval-cancel').onclick=()=>$('approval').close();
$('approval-form').addEventListener('submit',async e=>{e.preventDefault();const note=$('approval-note').value.trim();if(!note)return;$('approval').close();await submit('authorize',{maxTurns:Number($('turns').value),maxMinutes:$('minutes').value?Number($('minutes').value):null,note,scopeHash:approvalHash});});
addEventListener('online',()=>{if(session){void refresh();connect();}});document.addEventListener('visibilitychange',()=>{if(!document.hidden&&session)void refresh();});
try{await enter(await request('session'));}catch(e){if(e.status!==401)$('login-error').textContent=e.message;}
