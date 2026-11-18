import { createElement as h, useEffect, useState } from 'react';
import { host, useValue, Button, Textarea, gatewayActivationEpoch, useGatewayActivationEpoch, TRANSCRIPT_DIRECTIVE_AREA } from '@hermes/plugin-sdk';

const labels={PROPOSED:'等你批准',RUNNING:'OpenCode 開發中',VERIFYING:'離線驗證中',WAITING_APPROVAL:'等待命令批准',REVIEW:'等待你驗收',ACCEPTED:'候選已接受',
  REJECTED:'提案已拒絕',FAILED:'執行未通過',CANCEL_REQUESTED:'已要求取消',PROCESS_TERMINATED:'程序已停止',TERMINATION_UNKNOWN:'結果尚未確認'};
const box={padding:'14px',borderBottom:'1px solid var(--ui-stroke-secondary)',fontSize:'13px',lineHeight:1.6,minWidth:0};
const muted={color:'var(--ui-text-secondary)'};
const wrap={overflowWrap:'anywhere'};
const active=new Set(['RUNNING','WAITING_APPROVAL','VERIFYING','CANCEL_REQUESTED']);

export function objectivePreview(objective){
  const text=objective.replace(/\s+/g,' ').trim();
  return text.length>180?text.slice(0,180)+'…':text;
}
export function canVerify(task){
  const stopped=['FAILED','REVIEW','PROCESS_TERMINATED'].includes(task.status) && !task.completion;
  return (stopped||task.verification_upgrade_required===true) && task.process_status==='PROCESS_TERMINATED' &&
    !task.requests.some(r=>['unknown','inflight','reserved'].includes(r.status));
}

export function currentScope(){
  const session=host.state.focusedStoredSessionId.get();
  const profile=host.state.profile.get();
  const owner=host.state.focusedSessionProfile.get();
  return {session,profile,owner,epoch:gatewayActivationEpoch(),key:JSON.stringify([session,profile,owner,gatewayActivationEpoch()])};
}
function sameScope(scope){return currentScope().key===scope.key && !!scope.session && (scope.profile||'default')===(scope.owner||'default');}

export async function performAction(ctx,scope,task,action,extra={}){
  if(!sameScope(scope))throw new Error('對話或連線已切換，請回到原對話後操作。');
  const result=await ctx.rest('/action',{method:'POST',body:{session_id:scope.session,task_id:task.objective_id,version:task.approval_version,action,...extra}});
  return sameScope(scope)?result:null;
}
export function canAccept(task){
  return task.status==='REVIEW' && task.allowed_commands.length>0 && !task.requests.some(r=>['unknown','inflight'].includes(r.status)) &&
    task.allowed_commands.every(command=>task.checks.some(c=>c.id===command.id && c.version===task.approval_version && c.exit_code===0 && c.fingerprint===task.candidate_fingerprint));
}
export function canApply(task,preview){
  return task.status==='ACCEPTED' && preview?.ready===true && preview.objective_id===task.objective_id &&
    preview.approval_version===task.approval_version && /^[a-f0-9]{64}$/.test(preview.token??'') &&
    !task.requests.some(r=>['unknown','inflight','reserved'].includes(r.status)) &&
    (!task.integration||task.integration.status==='ROLLED_BACK');
}
export function integrationMessage(task){
  const state=task.integration?.status;
  if(state==='APPLIED')return '已套回本機專案。備份與候選保留；尚未 Git 提交、推送或部署。';
  if(state==='ROLLED_BACK')return '本次套用已撤回，原檔與權限已恢復。候選和備份仍保留。';
  if(state==='RECOVERY_REQUIRED')return '套用／回復遇到衝突，已保留後來的修改與原檔備份。請先核對衝突檔案。';
  if(['APPLYING','ROLLING_BACK'].includes(state))return '套用／回復尚未確認完成。若程序已中斷，可用備份回復；不會強制覆寫後來的修改。';
  return '候選與驗收已保存，原專案尚未套用。預覽確認後才能套回。';
}
function verifiedCandidate(task){
  return task.verification?.status==='PASSED' && task.verification.approval_version===task.approval_version &&
    task.verification.fingerprint===task.candidate_fingerprint;
}
export function verificationMessage(task){
  const state=task.verification?.status;
  if(verifiedCandidate(task))return '現存候選已通過離線驗證；模型停止紀錄和已用額度保留。';
  if(state==='PASSED')return '保留舊候選的離線驗證紀錄；目前版本須依現有驗收結果判斷。';
  if(state==='RUNNING')return '正在執行已批准的驗收命令；不呼叫模型。';
  if(state==='TERMINATION_UNKNOWN')return '離線驗證程序是否停止尚未確認，已保留紀錄，不會自動重試。';
  return `離線驗證${state==='CANCELLED'?'已取消':'未通過'}。${task.verification?.error??''}`;
}
export function failureMessage(task){
  if(task.error==='REQUEST_LIMIT' && verifiedCandidate(task))return '模型請求上限紀錄保留。現存候選已另行通過離線驗證，可核對 Diff 後驗收；沒有重派模型。';
  if(task.error==='REQUEST_LIMIT')return '這個任務的請求額度已用完，已保留候選 Diff。先核對現有成果；不會自動重置額度或重新派發。';
  if(task.error==='TASK_DEADLINE')return '這個任務的執行時間已到上限。請先核對保留的候選與請求狀態。';
  return task.error??'';
}
function actionFailure(error){
  const code=String(error.message??error).slice(0,1000);
  const hints=[
    ['NOTE_VERSION_CONFLICT','這筆紀錄已被其他視窗更新。請核對刷新後的內容，再決定是否修改。'],
    ['NOTE_ID_CONFLICT','同一保存操作的內容不一致。請先查看已保存紀錄，避免重複新增。'],
    ['NOTE_LIMIT','這個任務已達 32 筆接續紀錄上限；既有紀錄仍保留，不會刪除歷史。'],
    ['EXECUTOR_PLATFORM_NOT_VERIFIED','Wisp 開發與離線驗收目前只支援 Linux。可繼續使用 Hermes 聊天及查看原成果。'],
    ['EXECUTOR_ARCH_NOT_VERIFIED','目前只驗證 Linux x86_64 執行環境，原任務與候選會保留。'],
    ['CHECK_ISOLATION_UNAVAILABLE','請先補齊所列隔離工具，再重新核對前置條件；不會切換為無隔離執行。'],
    ['EXECUTOR_RUNTIME_MISSING','請重新準備 Wisp 固定版執行環境。既有任務和候選保留。'],
    ['PINNED_RUNTIME_REQUIRED','目前執行環境版本不符，請重新準備固定版本。不要直接更新成任意最新版。'],
    ['SOURCE_CHANGED','來源檔案已改變。請先比對來源與候選 Diff，保留現有編輯；不要強制覆蓋。'],
    ['CANDIDATE_SCOPE_CHANGED','候選超出原核准範圍。請先核對候選檔案，不擴張範圍或直接套回。'],
    ['CANDIDATE_MODE_CHANGED','候選檔案權限與套回規則不符。請核對候選的權限，再重新執行離線驗收。'],
    ['CANDIDATE_CHANGED','候選內容已改變。請重新核對 Diff 與驗收結果，不能沿用舊預覽套回。'],
    ['VERSION_CONFLICT','批准版本已改變。請核對刷新後的任務卡，再決定下一步。'],
    ['PREVIEW_','預覽已過期或內容已改變。請重新預覽並核對，舊批准不會自動重用。'],
    ['REQUEST_LIMIT','本任務模型額度已用完。請核對保留的候選；不會重置額度或自動重派。'],
    ['BUDGET_EXHAUSTED','本任務已達請求或時間上限。請先核對現有候選與收據，不重置額度。'],
    ['TASK_DEADLINE','本任務已達時間上限。請核對現有候選與收據。'],
    ['REQUEST_UNSETTLED','有請求結果尚未確認。請保留原收據並確認狀態，不要重送。'],
    ['WORKER_STILL_RUNNING','工作者仍在執行。請等候完成或透過任務卡取消，再核對停止狀態。'],
    ['APPLY_IN_PROGRESS','同一專案正在套用或回復。請先查看該操作的收據。'],
    ['CHECKS_REQUIRED','目前候選尚未通過必要驗收。請先核對驗收命令與結果。']
  ];
  return `${code}。${hints.find(([match])=>code.includes(match))?.[1]??'請先核對任務狀態與收據；若結果尚未確認，不要重複送出。'}`;
}
function control(label,onClick,{primary=false,disabled=false}={}){
  return h(Button,{type:'button',variant:primary?'default':'secondary',size:'touch',onClick,disabled},label);
}
function details(title,children,open=false){return h('details',{open,style:{marginTop:'12px'}},h('summary',{style:{cursor:'pointer',fontWeight:600}},title),children);}

function sourceLabel(provider){return provider==='hermes-openai-codex'?'Hermes 的 ChatGPT／Codex 訂閱':`尚未辨識的來源：${provider??'未指定'}`;}
function capabilityMessage(value){
  if(!value)return '尚未取得執行前置檢查結果，請重新整理任務。';
  if(value.ready)return '檔案與版本前置檢查通過';
  return value.issues?.map(issue=>issue.message).join(' ')||'目前無法執行，請重新整理並核對執行環境。';
}

export function SourceOverview({ctx}){
  useValue(host.state.focusedStoredSessionId);useValue(host.state.profile);useValue(host.state.focusedSessionProfile);useGatewayActivationEpoch();
  const scope=currentScope();
  const [data,setData]=useState(null),[pending,setPending]=useState(null),[error,setError]=useState(null);
  const busy=pending?.key===scope.key;
  const read=async()=>{
    if(!sameScope(scope)||busy)return;
    const operation={key:scope.key};setPending(operation);setError(null);
    try{
      const value=await ctx.rest(`/overview?session_id=${encodeURIComponent(scope.session)}`);
      if(sameScope(scope))setData({key:scope.key,value,at:new Date().toLocaleTimeString()});
    }catch(e){if(sameScope(scope))setError({key:scope.key,message:String(e.message??e).slice(0,1000)});}
    finally{setPending(current=>current===operation?null:current);}
  };
  const value=data?.key===scope.key?data.value:null;
  const sources=value?.sources,usage=value?.usage;
  if(!sameScope(scope))return h('p',{style:muted},'請先開啟已儲存的對話，再查看來源與用量。');
  return h('section',{'aria-label':'模型來源與用量',style:{...wrap,paddingTop:'8px'}},
    h('p',{style:muted},'只讀本機設定與這個對話的 Wisp 帳本，不呼叫模型。'),
    control(busy?'讀取中…':value?'重新整理來源與用量':'讀取來源與用量',read,{disabled:busy}),
    error?.key===scope.key&&h('p',{role:'alert'},`無法更新：${error.message}。若已有數值，仍是上次讀取結果。`),
    value&&h('div',null,
      h('p',{style:muted},`讀取時間：${data.at}`),
      h('strong',null,'來源接點'),
      h('p',null,`Hermes 預設：${sources.hermes_default.provider??'未讀到來源'} / ${sources.hermes_default.model??'未讀到模型'}`),
      h('p',{style:muted},'這是 profile 預設設定；個別聊天可另選模型。開發任務以批准卡上的來源為準。'),
      h('p',null,`開發執行器：${sources.executor}。登入有效性未查驗。`),
      h('p',null,`開發前置條件：${capabilityMessage(sources.capabilities?.development)}`),
      h('p',null,`離線驗收前置條件：${capabilityMessage(sources.capabilities?.verification)}`),
      h('p',{style:muted},'此檢查不啟動程序；核心隔離政策尚未由此檢查實測，執行驗收仍須通過原有隔離。'),
      h('ul',null,...sources.development_sources.map(source=>h('li',{key:source.id},`${source.label}：開發接點已實作`))),
      h('p',null,'agy／API Quota Broker 開發接點尚未接通；不會自動轉用其他來源。'),
      h('strong',null,'這個對話的開發用量'),
      h('p',null,`${usage.task_count} 個任務 · 已用 ${usage.requests_used} 次請求名額 · ${usage.dispatch_committed} 次已進入派送階段`),
      h('p',null,`已回應 ${usage.request_states.completed} · 失敗 ${usage.request_states.failed} · 請求未知 ${usage.request_states.unknown} · 處理中 ${usage.request_states.inflight}`),
      h('p',null,`未送出保留 ${usage.request_states.reserved} · 送出前取消 ${usage.request_states.cancelled} · 任務結果未知 ${usage.unknown_tasks}`),
      (usage.unattributed_requests>0||usage.request_states.unrecognized>0)&&h('p',{role:'alert'},`另有 ${usage.unattributed_requests} 個名額缺少逐筆紀錄、${usage.request_states.unrecognized} 筆未辨識狀態；不能視為未使用。`),
      ...usage.by_model.map(row=>h('div',{key:JSON.stringify([row.provider,row.model]),style:{borderTop:'1px solid var(--ui-stroke-secondary)',padding:'8px 0'}},
        h('strong',null,row.model),h('p',{style:muted},sourceLabel(row.provider)),h('p',null,`${row.task_count} 個任務 · ${row.requests_used} 次名額 · ${row.dispatch_committed} 次進入派送`))),
      h('p',{style:muted},'這是本對話 Wisp 工作者的本地紀錄，不是供應商帳戶剩餘額度。保留／取消仍計入原任務上限；已進入派送不代表實際計費。'),
      h('p',{style:muted},'帳戶餘額、到期時間、tokens 與費用：未查詢。未包含 Hermes 日常聊天或其他工具的模型用量。')));
}

export function TaskNotes({task,act,busy}){
  const [kind,setKind]=useState('todo'),[text,setText]=useState(''),[attempt,setAttempt]=useState(null);
  const notes=task.notes??[];
  const save=async()=>{
    if(busy||!text.trim()||notes.length>=32)return;
    // A retry after a lost response uses the same operation ID and payload.
    // Editing the draft explicitly begins a different save operation.
    const payload=attempt??{note_id:crypto.randomUUID().replaceAll('-',''),note_kind:kind,note_text:text.trim()};
    setAttempt(payload);
    const result=await act(task,'record_note',payload);
    if(result){setText('');setAttempt(null);}
  };
  return h('section',{'aria-label':'決策與待辦紀錄',style:wrap},
    h('p',{style:muted},'保存與這個任務有關的決策、未完成事項，供原對話或已開啟分享的同專案接續。這不會執行新工作，也不代表任務通過驗收。'),
    notes.length===0&&h('p',null,'尚無接續紀錄。'),
    ...notes.map(note=>h('article',{key:note.id,style:{borderTop:'1px solid var(--ui-stroke-secondary)',padding:'10px 0'}},
      h('strong',null,note.kind==='todo'?`待辦 · ${note.status==='done'?'已完成':'未完成'}`:`決策 · ${note.status==='withdrawn'?'已撤回':'有效紀錄'}`),
      h('p',{style:{whiteSpace:'pre-wrap',margin:'6px 0'}},note.text),
      note.kind==='todo'&&control(note.status==='done'?'重新開啟待辦':'標記完成',()=>act(task,'update_note',{
        note_id:note.id,note_revision:note.revision,note_status:note.status==='done'?'open':'done'}),{disabled:busy}),
      note.kind==='decision'&&note.status==='active'&&control('撤回這筆決策',()=>act(task,'update_note',{
        note_id:note.id,note_revision:note.revision,note_status:'withdrawn'}),{disabled:busy}),
      details('紀錄來源',h('p',{style:muted},`${note.source.channel==='gui'?'GUI 保存':'委託操作者保存'} · ${new Date(note.created_at*1000).toLocaleString()} · 原批准版本 ${note.source.approval_version} · 紀錄修訂 ${note.revision} · 對話 ${note.source.session_id} · 任務 ${note.source.objective_id}`)))),
    h('label',{style:{display:'block',marginTop:'10px'}},'紀錄類型 ',h('select',{value:kind,disabled:busy,onChange:e=>{setKind(e.target.value);setAttempt(null);},
      style:{background:'var(--ui-bg-secondary)',color:'inherit',padding:'8px',border:'1px solid var(--ui-stroke-secondary)'}},
      h('option',{value:'todo'},'待辦事項'),h('option',{value:'decision'},'決策紀錄'))),
    h('label',{style:{display:'block',marginTop:'8px'}},'紀錄內容',h(Textarea,{value:text,disabled:busy,maxLength:1000,rows:3,
      onChange:e=>{setText(e.target.value);setAttempt(null);},style:{width:'100%',margin:'6px 0'}})),
    h('p',{style:muted},`每筆最多 1000 字；本任務 ${notes.length} / 32 筆。舊紀錄保留，不自動套用為個人偏好。`),
    control('保存這筆紀錄',save,{disabled:busy||!text.trim()||notes.length>=32}));
}

export function TaskCard({task,act,busy,copyPatch}){
  const [feedback,setFeedback]=useState('');
  const [preview,setPreview]=useState(null),[project,setProject]=useState(null),[confirmUndo,setConfirmUndo]=useState(false),[verifyPreview,setVerifyPreview]=useState(null);
  const loadPreview=async()=>{setPreview(null);const result=await act(task,'preview_apply');if(result)setPreview(result);};
  const loadProject=async()=>{const result=await act(task,'project_context');if(result)setProject(result);};
  const shareProject=async()=>{const result=await act(task,'share_project',{allow:!project.sharing.enabled});if(result)setProject(result);};
  const previewVerify=async()=>{setVerifyPreview(null);const result=await act(task,'preview_verify');if(result)setVerifyPreview(result);};
  const canRevise=['REVIEW','FAILED'].includes(task.status) && task.requests_used<task.limits.max_requests && !task.requests.some(r=>['inflight','unknown'].includes(r.status));
  const pending=task.permissions.filter(p=>p.version===task.approval_version && p.decision==='pending');
  const development=task.capabilities?.development,verification=task.capabilities?.verification;
  return h('article',{style:box,'aria-label':objectivePreview(task.objective)},
    h('div',{style:{display:'flex',justifyContent:'space-between',gap:'12px',alignItems:'baseline'}},
      h('strong',null,labels[task.status]??task.status),h('span',{style:muted},`批准版本 ${task.approval_version}`)),
    h('p',{style:{...wrap,fontSize:'15px',margin:'10px 0'}},objectivePreview(task.objective)),
    task.objective.length>180&&details('完整交辦與限制',h('p',{style:{...wrap,whiteSpace:'pre-wrap'}},task.objective)),
    h('p',{style:{...muted,margin:'4px 0'}},`OpenCode · ${task.model} · 請求額度 ${task.requests_used} / ${task.limits.max_requests}（含已保留）`),
    details('工作範圍與上限',h('div',{style:wrap},
      h('p',null,'來源：',task.repo),h('p',null,'可修改：',task.allowed_paths.join('、')),
      details(`可讀取範圍 · ${task.read_paths.length} 個檔案`,h('ul',null,...task.read_paths.map(name=>h('li',{key:name},h('code',null,name))))),
      h('p',null,`模型來源：${sourceLabel(task.provider)}。會使用批准來源的額度；登入有效性在執行時核對。`),
      h('p',null,`執行總上限 ${task.limits.max_seconds} 秒；修正沿用已用額度。`),
      h('p',null,'驗收命令：'),h('ul',null,...task.allowed_commands.map(c=>h('li',{key:c.id},h('code',null,JSON.stringify(c.argv))))),
      h('p',{style:muted},'只修改候選副本，原專案保持原樣。')),task.status==='PROPOSED'),
    (task.status==='PROPOSED'||canRevise) && development?.ready!==true && h('p',{role:'status'},`開發暫不能啟動：${capabilityMessage(development)}`),
    task.status==='PROPOSED' && h('div',{style:{display:'flex',gap:'8px',marginTop:'12px',flexWrap:'wrap'}},
      control('批准開發',()=>act(task,'approve'),{primary:true,disabled:busy||development?.ready!==true}),control('拒絕提案',()=>act(task,'reject'),{disabled:busy})),
    ...pending.map(p=>h('section',{key:p.id,style:{background:'var(--ui-bg-quaternary)',padding:'12px',marginTop:'12px'}},
      h('strong',null,'驗收命令需要批准'),h('pre',{style:{...wrap,whiteSpace:'pre-wrap'}},JSON.stringify(p.argv)),
      h('p',null,'在候選副本的唯讀隔離環境執行，關閉網路。'),
      verification?.ready!==true&&h('p',{role:'status'},capabilityMessage(verification)),
      h('div',{style:{display:'flex',gap:'8px',flexWrap:'wrap'}},
        control('允許這次命令',()=>act(task,'check',{request_id:p.id,allow:true}),{primary:true,disabled:busy||verification?.ready!==true}),
        control('拒絕命令',()=>act(task,'check',{request_id:p.id,allow:false}),{disabled:busy})))),
    active.has(task.status) && h('div',{style:{marginTop:'12px'}},control(task.status==='CANCEL_REQUESTED'?'正在確認停止…':'取消這個任務',()=>act(task,'cancel'),{disabled:busy||task.status==='CANCEL_REQUESTED'})),
    task.status==='TERMINATION_UNKNOWN' && h('p',{role:'status'},'程序或模型結果尚未確認。已停止自動派發，請保留此任務與收據；不會自動重試或改投另一個模型。'),
    task.error && h('p',{role:'alert',style:wrap},failureMessage(task)),
    task.verification && h('p',{role:'status',style:wrap},verificationMessage(task)),
    task.summary && details('執行器摘要',h('p',{style:{...wrap,whiteSpace:'pre-wrap'}},task.summary)),
    task.checks.length>0 && details('驗收結果',h('div',null,...task.checks.map(c=>h('div',{key:c.id,style:{padding:'8px 0'}},
      h('strong',null,`${c.id}：${c.exit_code===0?'通過':'未通過'}（exit ${c.exit_code??'未知'}）`),
      h('pre',{style:{whiteSpace:'pre-wrap',...wrap,maxHeight:'180px',overflow:'auto'}},[c.stdout,c.stderr,c.code].filter(Boolean).join('\n'))))),task.status==='REVIEW'),
    task.diff && details(`候選 Diff · ${task.changes.length} 個檔案`,h('pre',{style:{whiteSpace:'pre',overflow:'auto',maxHeight:'360px',fontSize:'12px',background:'var(--ui-bg-quaternary)',padding:'10px'}},task.diff),task.status==='REVIEW'),
    task.diff && control('複製候選 Patch',()=>copyPatch(task),{disabled:busy}),
    task.status==='REVIEW' && h('div',{style:{marginTop:'12px'}},control('接受候選並結案',()=>act(task,'accept'),{primary:true,disabled:busy||!canAccept(task)}),
      !canAccept(task)&&h('p',{style:muted},'目前候選尚未通過全部驗收，不能結案。')),
    canVerify(task) && details('接手修正與離線驗證',h('div',null,
      task.verification_upgrade_required&&h('p',{role:'status'},'這筆候選使用舊版驗收紀錄。請核對候選檔案權限並重新驗證，再接受套回。'),
      h('p',null,'可在候選目錄手動補完原範圍，再執行已列出的驗收命令。這不會重派模型、重置額度或改寫原停止紀錄。'),
      verification?.ready!==true&&h('p',{role:'status'},`離線驗收暫不能啟動：${capabilityMessage(verification)}`),
      task.candidate_directory&&h('p',{style:wrap},'候選目錄：',h('code',null,task.candidate_directory)),
      control('預覽重新驗證',previewVerify,{disabled:busy}),
      verifyPreview&&h('div',null,h('p',null,`已修改 ${verifyPreview.files.length} 個檔案；總上限 ${verifyPreview.max_seconds} 秒，模型請求 0 次。`),
        h('ul',null,...verifyPreview.commands.map(c=>h('li',{key:c.id},h('code',{style:wrap},JSON.stringify(c.argv))))),
        control('批准離線檢查（不呼叫模型）',async()=>{const result=await act(task,'verify',{preview_token:verifyPreview.token});if(result)setVerifyPreview(null);},{primary:true,disabled:busy||verification?.ready!==true})))),
    canRevise && details('退回修正',h('div',null,h('label',{htmlFor:`feedback-${task.objective_id}`},'需要調整的地方'),
      h(Textarea,{id:`feedback-${task.objective_id}`,value:feedback,onChange:e=>setFeedback(e.target.value),maxLength:8000,rows:3,style:{width:'100%',margin:'8px 0'}}),
      control('批准這次修正',()=>act(task,'revise',{feedback}),{disabled:busy||!feedback.trim()||development?.ready!==true}))),
    task.completion && h('section',{'aria-label':'套回原專案',style:{marginTop:'16px',padding:'12px',background:'var(--ui-bg-quaternary)'}},
      h('strong',null,'套回原專案'),h('p',{role:'status','aria-live':'polite'},integrationMessage(task)),
      (!task.integration||task.integration.status==='ROLLED_BACK') && control('預覽套回範圍',loadPreview,{disabled:busy||task.verification_upgrade_required===true}),
      preview && (!task.integration||task.integration.status==='ROLLED_BACK') && h('div',null,
        h('p',{style:wrap},`目的地：${preview.repo}`),h('ul',null,...preview.files.map(name=>h('li',{key:name},h('code',null,name)))),
        preview.conflicts.length>0 && h('p',{role:'alert'},`來源已改變：${preview.conflicts.join('、')}。這次不會覆蓋；候選 Patch 仍可複製。`),
        preview.ready && h('p',null,'將先備份原檔，再套回這份已驗收的候選。'),
        control('確認套回這些檔案',async()=>{const result=await act(task,'apply',{preview_token:preview.token});if(result)setPreview(null);},{primary:true,disabled:busy||!canApply(task,preview)})),
      task.integration?.conflicts?.length>0 && h('p',{role:'alert',style:wrap},`需核對：${task.integration.conflicts.join('、')}`),
      task.integration && details('套用收據與原檔備份',h('div',{style:wrap},
        h('p',null,`操作 ${task.integration.id}`),h('p',null,`備份：${task.integration.backup}`),
        h('p',null,`批准來源：${task.integration.actor==='human'?'GUI 操作':'已獲授權的委託操作者'}`))),
      ['APPLIED','APPLYING','ROLLING_BACK','RECOVERY_REQUIRED'].includes(task.integration?.status) && details('撤回／回復本次套用',h('div',null,
        h('p',null,'僅恢復仍符合本次候選的檔案；發現後來的編輯會保留並停止。這不會刪除任務或備份。'),
        h('label',{style:{display:'flex',alignItems:'center',gap:'8px',padding:'8px 0'}},
          h('input',{type:'checkbox',checked:confirmUndo,onChange:e=>setConfirmUndo(e.target.checked),disabled:busy}),'我要恢復套用前的原檔'),
        control('確認撤回／回復',async()=>{const result=await act(task,'rollback',{apply_id:task.integration.id});if(result){setConfirmUndo(false);setPreview(null);}},{disabled:busy||!confirmUndo})))),
    details(`決策與待辦 · ${(task.notes??[]).filter(n=>n.status==='open').length} 項未完成`,h(TaskNotes,{task,act,busy})),
    details('專案接續與進度',h('section',{'aria-label':'專案接續'},
      control(project?'重新整理專案摘要':'讀取專案摘要',loadProject,{disabled:busy}),
      project && h('div',null,
        h('p',{style:wrap},project.repo),
        h('p',null,project.sharing.enabled?'已開啟同專案跨對話接續。新對話可讀取帶來源的任務摘要。':'目前只讀本對話。可開啟同專案跨對話接續；不會讀其他專案或完整聊天。'),
        control(project.sharing.enabled?'關閉跨對話接續':'開啟同專案跨對話接續',shareProject,{disabled:busy}),
        h('p',{style:muted},'摘要只供接續參考，不代表批准新的工作。'),
        ...project.tasks.map(row=>h('div',{key:row.objective_id,style:{borderTop:'1px solid var(--ui-stroke-secondary)',padding:'10px 0'}},
          h('strong',null,row.objective),h('p',null,labels[row.status]??row.status),h('p',null,row.next_step),
          ...(row.notes??[]).map(note=>h('p',{key:note.id,style:wrap},`${note.kind==='todo'?'待辦':'決策'}：${note.text}`)),
          row.notes_truncated&&h('p',{style:muted},'摘要有省略；完整紀錄與來源可在原任務卡查看。'),
          h('p',{style:{...muted,...wrap}},`來源對話 ${row.source.session_id} · 任務 ${row.objective_id}`))),
        project.truncated&&h('p',{style:muted},'顯示最近 20 項任務。')))),
    details('追溯來源',h('div',null,h('p',{style:{...muted,...wrap}},`對話 ${task.session_id} · 任務 ${task.objective_id}`),
      h('ol',null,...(task.events??[]).slice(-12).map(event=>h('li',{key:event.seq},`${new Date(event.at*1000).toLocaleTimeString()} · ${event.kind}`))))));
}

function Workflow({ctx,taskId,sessionId}){
  useValue(host.state.focusedStoredSessionId);useValue(host.state.profile);useValue(host.state.focusedSessionProfile);useGatewayActivationEpoch();
  const scope=currentScope();
  const key=JSON.stringify([scope.key,taskId,sessionId]);
  const [data,setData]=useState(null),[fetchError,setFetchError]=useState(null),[actionError,setActionError]=useState(null),
    [operation,setOperation]=useState(null),[notice,setNotice]=useState(null);
  const busy=operation?.key===key;
  const permitted=sameScope(scope)&&(!sessionId||scope.session===sessionId);
  useEffect(()=>{
    let alive=true,polling=false;
    const refresh=async()=>{
      if(!permitted||polling)return;
      polling=true;
      try{
        const response=await ctx.rest(taskId?`/tasks/${encodeURIComponent(taskId)}?session_id=${encodeURIComponent(scope.session)}`:`/tasks?session_id=${encodeURIComponent(scope.session)}`);
        if(alive&&sameScope(scope)){setData({key,tasks:taskId?[response]:response.tasks});setFetchError(null);}
      }catch(e){if(alive&&sameScope(scope))setFetchError({key,message:String(e.message??e)});}
      finally{polling=false;}
    };
    void refresh();const timer=setInterval(refresh,1500);
    return()=>{alive=false;clearInterval(timer);};
  },[scope.key,taskId,sessionId]);
  const act=async(task,action,extra)=>{
    if(busy)return;
    const pending={key};setOperation(pending);setActionError(null);setNotice(null);
    try{
      const updated=await performAction(ctx,scope,task,action,extra);
      if(updated?.status)setData(previous=>previous?.key===key?{key,tasks:previous.tasks.map(t=>t.objective_id===updated.objective_id?updated:t)}:previous);
      if(updated && ['apply','rollback','share_project'].includes(action))setNotice({key,message:action==='share_project'?'專案接續設定已保存。':integrationMessage(updated)});
      return updated;
    }catch(e){if(sameScope(scope))setActionError({key,message:actionFailure(e)});}
    finally{setOperation(current=>current===pending?null:current);}
  };
  const tasks=data?.key===key?data.tasks:null;
  const readError=fetchError?.key===key?fetchError.message:'';
  const failedAction=actionError?.key===key?actionError.message:'';
  const copyPatch=async task=>{
    if(!sameScope(scope))return;
    setActionError(null);setNotice(null);
    try{const copied=await ctx.os.writeClipboard(task.diff);if(sameScope(scope))setNotice({key,message:copied?'候選 Patch 已複製。來源套用狀態請看任務收據。':'剪貼簿未完成，請重試。'});}
    catch(e){if(sameScope(scope))setActionError({key,message:'無法複製 Patch，請確認剪貼簿權限後再試。來源檔案沒有因此改動。'});}
  };
  return h('div',{style:{height:'100%',overflow:'auto',color:'var(--ui-text-primary)',fontFamily:'inherit'}},
    h('header',{style:box},h('h2',{style:{margin:0,fontSize:'16px',fontWeight:600}},'Wisp 開發任務'),
      h('p',{style:{...muted,margin:'6px 0 0'}},'留在這個對話，核對範圍、看進度與驗收。'),
      !taskId&&details('模型來源與用量',h(SourceOverview,{ctx}))),
    !permitted?h('p',{style:box},'請開啟任務所屬的對話與 profile。'):
    h('div',null,readError&&h('p',{role:'alert',style:{...box,...wrap}},`進度暫時無法更新：${readError}。請查看 Backend 連線狀態；畫面保留上次讀取的結果。`),
      failedAction&&h('section',{style:{...box,...wrap}},h('p',{role:'alert'},`操作未完成：${failedAction}`),control('關閉操作提示',()=>setActionError(null))),
      notice?.key===key&&h('p',{role:'status',style:box},notice.message),
      tasks===null&&!readError&&h('p',{role:'status',style:box},'正在讀取這個對話的任務…'),
      tasks?.length===0&&h('div',{style:box},h('p',null,'這個對話還沒有開發任務。'),h('p',{style:muted},'直接在聊天中描述要修正的問題。Wisp 會先列出可修改檔案與驗收方式，等你批准後再交給 OpenCode。')),
      ...(tasks??[]).map(task=>h(TaskCard,{key:JSON.stringify([scope.key,task.objective_id]),task,act,busy,copyPatch}))));
}

export default {
  id:'wisp-core',name:'Wisp 開發流程',defaultEnabled:false,
  register(ctx){
    ctx.register({id:'workflow',area:'panes',title:'Wisp 任務',data:{placement:'right',width:'380px'},render:()=>h(Workflow,{ctx})});
    ctx.register({id:'task-card',area:TRANSCRIPT_DIRECTIVE_AREA,data:{name:'wisp-task',render:({attrs,sessionId})=>
      /^[a-f0-9]{32}$/.test(attrs.id??'')?h(Workflow,{ctx,taskId:attrs.id,sessionId}):null}});
  }
};
