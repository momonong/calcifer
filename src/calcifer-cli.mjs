import { homedir } from 'node:os';
import { MAX_EXECUTION_MINUTES, MAX_PROJECT_CALLS } from './project-execution.mjs';
import { isAbsolute, join, resolve, sep, dirname, basename } from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { readText } from './workspace-tools.mjs';
import { safeText as safe, createOutput, statusView, operationView, errorCode } from './cli-protocol.mjs';

const HELP = `Calcifer — 依任務分配模型的專案開發工作階段
直接執行 calcifer：選擇既有專案並開啟對話。
用法：calcifer [命令] --project 名稱 [--state /絕對路徑]
同義入口：calcifer --status --project 名稱；每個命令也可寫成 --命令。
  list | version  列出既有專案／工具版本；不需要選擇專案。
  init --repo /專案路徑 --profile /設定.json --backend codex|agy
       [--model 模型ID --effort 深度]，或以 --routing /路由.json 取代 --backend
  start [--yes]  啟動已準備的目標；先確認資源，再工作與成果交付。
  deliver  重做 patch 或文件交付，不呼叫模型。
  prepare --task-file /需求.md --title "目標" --turns N --note "範圍"
          [--documents /文件轉換設定.json]  凍結新工作階段的任務，不授權模型。
  work --task-file /需求.md  從檔案送入需求；不可同時提供需求文字。
  files | result  唯讀列出檔案／核對現有交付物；不測試、不派送模型。
  status | work "需求" | test | diff | export [--output /補丁路徑] | recover
  resume  接續已知失敗的 routed task；abandon --note "原因" 保留紀錄後放棄未完成目標
  revise --note "具體修訂" 或 --note-file /審閱.md  記錄已完成成果的修訂；不呼叫模型，之後 start 接續。
  authorize --turns N [--minutes N] --note "用途" [--yes]
  calcifer --project 名稱  直接接續指定專案；非終端只顯示狀態。
  register --project 名稱 --state /既有工作階段  登錄自訂位置，不授權或派送模型。
互動：/start /deliver /help /status /files /test /diff /export /recover /resume /abandon 原因 /authorize N [M] /quit
目前驗證器支援 Python 3.12 unittest；專案名稱、來源與可寫目錄由設定決定。
路由模式：規劃任務 → 選擇已授權模型 → 依相依順序執行 → 主機驗證 → 匯出 patch。
單模型模式仍可明確指定；不自動切帳號。規劃、實作與修正共用已授權呼叫次數（每階段最多 32 次）。預設不設執行期限；--minutes 可另設期限。
Ctrl-C 取消；結果未知先 recover，不自動重送。init 不授權模型。
相容舊入口：calcifer thor，等同選擇既有 thor 工作階段。`;
const OUTPUT_HELP='輸出：--json 只在 stdout 回傳一個 JSON 結果；--jsonl 回傳進度事件與最後結果。\n機器模式不等待互動確認；--yes 仍須已有相應的人類授權。退出碼：0 指令成功、1 操作失敗、2 用法或確認缺失。status 成功不代表目標已完成。';
const COMMANDS=['help','version','list','repl','init','register','prepare','start','deliver','status','files','result','work','test','diff','export','recover','resume','revise','abandon','authorize'];
function usage(message) { const e = new Error(message); e.code = 'CLI_USAGE'; return e; }
export function parseArgs(argv, home = homedir()) {
  const args = [...argv];
  if (!args.length) return { command: 'select' };
  const legacy=args[0]==='thor';if(legacy)args.shift();
  const opts = {}; const positional = [];let action;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['--yes','--force','--help','-h','--json','--jsonl'].includes(a)) { if (opts[a]) throw usage(`重複選項 ${a}`); opts[a] = true; continue; }
    if(a.startsWith('--')&&COMMANDS.includes(a.slice(2))&&a!=='--repl'){
      if(action||positional.length)throw usage('一次只接受一個命令；--命令 請放在需求文字之前。');
      action=a.slice(2);continue;
    }
    if (a.startsWith('--')) {
      if (!['--state', '--project', '--profile', '--backend', '--model', '--effort', '--routing', '--repo', '--seed', '--output', '--turns', '--minutes', '--note','--task-file','--note-file','--title','--documents'].includes(a)) throw usage(`不支援的選項：${a}`);
      if (opts[a] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw usage(`選項 ${a} 需要一個值且不可重複。`);
      opts[a] = args[++i];
    } else positional.push(a);
  }
  if(opts['--json']&&opts['--jsonl'])throw usage('--json 與 --jsonl 不可同時使用。');
  const machine=opts['--json']||opts['--jsonl'];
  let command = opts['--help'] || opts['-h'] ? 'help' : action || positional.shift() || (machine?opts['--project']||opts['--state']||legacy?'status':'list':'repl');
  if (!COMMANDS.includes(command)) throw usage(`未知命令：${command}`);
  if(command==='repl'&&machine)command='status';
  const allowed = { revise:['--note','--note-file'],prepare:['--task-file','--title','--turns','--note','--documents'],start:['--yes'],init:['--repo','--profile','--backend','--model','--effort','--routing',...(legacy?['--seed']:[])],work:['--task-file'],test:['--force'],export:['--output'],abandon:['--note'],authorize:['--turns','--minutes','--note','--yes'] }[command] || [];
  for (const k of Object.keys(opts)) if (!['--state','--project','--help','-h','--json','--jsonl',...allowed].includes(k)) throw usage(`${command} 不接受 ${k}`);
  if (command !== 'work' && positional.length) throw usage(`${command} 不接受額外文字。`);
  const project=opts['--project']||(legacy?'thor':null);
  if(project&&!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(project))throw usage('--project 請用英文小寫、數字、底線或連字號。');
  if(!['help','version','list'].includes(command)&&!project&&!opts['--state'])throw usage('請以 --project 名稱 或 --state /路徑 選擇工作階段。');
  if(command==='list'&&(project||opts['--state']))throw usage('list 列出所有已登錄專案，不接受 --project 或 --state。');
  if(command==='register'&&(!project||!opts['--state']))throw usage('register 需要 --project 名稱 與 --state /既有工作階段。');
  const stateDir = opts['--state'] || join(home, '.local', 'state', 'calcifer', project||'default');
  for (const [k,v] of Object.entries({ '--state':stateDir,'--repo':opts['--repo'],'--seed':opts['--seed'],'--profile':opts['--profile'],'--routing':opts['--routing'],'--output':opts['--output'],'--task-file':opts['--task-file'],'--note-file':opts['--note-file'],'--documents':opts['--documents'] })) if (v && !isAbsolute(v)) throw usage(`${k} 請使用絕對路徑。`);
  if (command === 'init' && !opts['--repo']) throw usage('初始化需要 --repo /專案絕對路徑。');
  if(command==='init'&&!legacy&&(!opts['--profile']||!opts['--routing']&&!['agy','codex'].includes(opts['--backend'])))throw usage('初始化需要 --profile /設定.json 與 --routing /路由.json 或 --backend codex|agy。');
  if(opts['--routing']&&['--backend','--model','--effort'].some(k=>opts[k]))throw usage('--routing 不能與固定 --backend、--model、--effort 同時使用。');
  if(opts['--backend']&&!['agy','codex'].includes(opts['--backend']))throw usage('後端須為 codex 或 agy。');
  if(command==='init'&&legacy&&opts['--backend']==='codex'&&!opts['--profile'])throw usage('Codex 接入請提供 --profile /設定.json，Thor 只是可選專案。');
  const task = positional.join(' ').trim();
  if (command === 'work' && !task&&!opts['--task-file']) throw usage('請在 work 後輸入需求，或用 --task-file 指定檔案。');
  if(task&&opts['--task-file'])throw usage('需求文字與 --task-file 不可同時提供。');
  if(command==='prepare'&&(!opts['--task-file']||!opts['--title']?.trim()))throw usage('prepare 需要 --task-file 與 --title。');
  if(command==='revise'&&((opts['--note']===undefined)===(opts['--note-file']===undefined)||(opts['--note']!==undefined&&(!opts['--note'].trim()||opts['--note'].length>8000))))throw usage('revise 需要 --note 或 --note-file 擇一，且修訂說明最多 8000 字元。');
  if(command==='abandon'&&!opts['--note']?.trim())throw usage('abandon 需要 --note 說明放棄原因；不會移除檔案或清除未知請求。');
  if (command === 'authorize'||command==='prepare') {
    for (const [k,max] of [['--turns',MAX_PROJECT_CALLS],...(opts['--minutes']===undefined?[]:[['--minutes',MAX_EXECUTION_MINUTES]])]) if (!/^\d+$/.test(opts[k] || '') || !Number.isSafeInteger(Number(opts[k])) || Number(opts[k]) < 1 || Number(opts[k]) > max) throw usage(`${k} 必須介於 1 與 ${max}。`);
    if (!opts['--note']?.trim()) throw usage('授權需要 --note 說明用途。');
  }
  return { command, stateDir:['help','version','list'].includes(command)?undefined:stateDir, task, opts, legacy, project };
}
async function defaultApi() {
  return { ...await import('./project-session.mjs'), ...await import('./project-workspace.mjs'), ...await import('./project-context.mjs'), ...await import('./project-profile.mjs'), ...await import('./project-routing.mjs'), ...await import('./project-registry.mjs'), ...await import('./prepared-project.mjs'), ...await import('./document-delivery.mjs'), ...await import('./project-result.mjs') };
}
async function inputText(path,maxFileBytes=50000){return (await readText(dirname(path),basename(path),{limits:{maxFileBytes},anyExtension:true})).content;}
async function seedContents(root) {
  const out = {}; const base = await realpath(root);
  for (const path of ['tools/liner_results.py','tests/test_liner_results.py']) {
    const file = join(base,path); const stat = await lstat(file); const canonical = await realpath(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !canonical.startsWith(base + sep) || stat.size > 262144) throw usage(`種子檔案不安全或過大：${path}`);
    const data = await readFile(file); if (data.includes(0)) throw usage(`種子不是文字：${path}`);
    out[path] = new TextDecoder('utf-8',{fatal:true}).decode(data);
  }
  return out;
}
export async function main(argv = process.argv.slice(2), injected = {}) {
  const input = injected.stdin || process.stdin, output = injected.stdout || process.stdout, errors = injected.stderr || process.stderr, proc = injected.process || process;
  const format=argv.includes('--jsonl')?'jsonl':argv.includes('--json')?'json':'text',machine=format!=='text';
  const transport=createOutput({format,stdout:output,stderr:errors}),say=s=>transport.message(s);
  let resultData=null,resultError=null;
  let parsed, rl, controller, promptController, activePhase;
  const finish=exitCode=>{transport.result({command:parsed?.command??null,project:parsed?.project,stateDir:parsed?.stateDir,exitCode,data:resultData,error:resultError});return exitCode;};
  const capture=(r,failed=false)=>{resultData=operationView(r);if(failed)resultError={code:r.code??(r.status==='unknown'?'RESULT_UNKNOWN':'PROJECT_OPERATION_FAILED'),message:r.status==='unknown'?'結果尚未核對；請先 recover。':'操作未通過，請依檢查結果修正。'};};
  const interrupted = () => { if (controller) { controller.abort(); transport.event('cancel_requested',{phase:activePhase??'work',remoteState:activePhase==='document'?'not-applicable':'unknown'});say(activePhase==='document'?'已要求取消本機文件轉換；模型成果保留，之後用 /deliver 重試。':'已要求取消；若結果未知，請使用 recover 核對，請勿重送。'); } else { promptController?.abort(); rl?.close(); } };
  try {
    const home = injected.home || homedir();
    parsed = parseArgs(argv, home);
    if (parsed.command === 'help') { const help=HELP+'\n'+OUTPUT_HELP;resultData={help};if(!machine)say(help);return finish(0); }
    if(parsed.command==='version'){const p=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));resultData={name:'calcifer',version:p.version,node:process.version};if(!machine)say(`Calcifer ${p.version} · Node ${process.version}`);return finish(0);}
    const api = injected.api || await defaultApi();
    let stateDir;
    proc.on('SIGINT',interrupted);proc.on('SIGTERM',interrupted);
    const showStatus = (s, compact=false) => {
      resultData=statusView(s);
      if(machine)return;
      say(`狀態：${s.status ?? '未知'}　專案：${s.projectId ?? '未指定'}`);
      say(`後端：${s.backend??'agy'}　專案設定：${s.projectName??'既有工作階段'}`);
      if(s.routing)say(`模式：依任務選模；規劃 profile：${s.routing.planner}。${s.goal?`目標狀態：${s.goal.status}`:''}`);
      for(const a of s.goal?.assignments??[])say(`分配 ${a.taskId} → ${a.execution.model} / ${a.execution.effort}：${compact?'輸入 /status 查看分配理由':a.plannerReason}`);
      say(`模型：${s.model ?? '未指定'}　用量：${s.turnsUsed ?? 0}/${s.maxTurns ?? '未授權'}　期限：${s.maxTurns==null||s.maxTurns===0?'未授權':s.maxMinutes===null?'不設執行期限':s.deadlineAt??'首次派送後計時'}`);
      say(`工作區：${s.workspaceDir ?? '未建立'}`);
      if (!compact && s.lastTask) say(`上次需求：${typeof s.lastTask === 'string' ? s.lastTask : s.lastTask.task ?? s.lastTask.id ?? '已記錄'}`);
      const response = s.lastResponse ?? s.lastTask?.response;
      if (!compact && typeof response === 'string' && response) say(`上次回覆：${response}`);
      if (s.changedFiles) say(`變更：${s.changedFiles.map(f=>typeof f==='string'?f:f.path).join('、') || '無'}`);
    };
    const ensureReadline = () => {
      if (!rl) { rl = (injected.createInterface || createInterface)({input,output,terminal:true}); rl.on('SIGINT', interrupted); rl.on('close',()=>promptController?.abort()); }
      return rl;
    };
    const question = async prompt => {
      promptController=new AbortController();
      try{return await ensureReadline().question(prompt,{signal:promptController.signal});}
      finally{promptController=undefined;}
    };
    if (parsed.command === 'select'||parsed.command==='list') {
      say('Calcifer — 選擇專案');
      const entries = await api.discoverProjects({home});
      const projects=[];
      for (const [i,entry] of entries.entries()) {
        try {
          if(entry.error)throw new Error(entry.error);
          const status=await api.projectStatus({stateDir:entry.stateDir});
          if(status.projectId!==entry.projectId)throw new Error('REGISTRY_IDENTITY_CHANGED');
          projects.push({project:entry.project,stateDir:entry.stateDir,...statusView(status)});
          say(`${i+1}. ${entry.project} · ${status.projectName??'專案'} · ${status.status??'未知'}${status.goal?` / ${status.goal.status}`:''}`);
          say(`   ${status.model??'未指定模型'} · 呼叫 ${status.turnsUsed??0}/${status.maxTurns??'未授權'}`);
        } catch(e) { entry.error=e.message; projects.push({project:entry.project,stateDir:entry.stateDir,error:{code:errorCode(e),message:errorText(e)}});say(`${i+1}. ${entry.project} · 無法開啟：${errorText(e)}`); }
      }
      resultData={projects};
      if(!entries.length){say('尚無已建立的專案。用 calcifer init 建立，或 calcifer register 登錄既有工作階段；calcifer --help 查看用法。');return finish(0);}
      if(parsed.command==='list'||machine)return finish(0);
      if(!input.isTTY||!output.isTTY){say('在終端直接執行 calcifer 選擇專案；也可用 calcifer --project 名稱 接續。');return finish(0);}
      for(;;){
        let answer;try{answer=(await question('輸入專案編號（q 離開）：')).trim();}catch{return 0;}
        if(!answer||answer==='q'||answer==='/quit')return 0;
        const entry=/^[1-9]\d*$/.test(answer)?entries[Number(answer)-1]:null;
        if(!entry||entry.error){say('請輸入可開啟專案的有效編號，或 q 離開。');continue;}
        parsed={command:'repl',project:entry.project,stateDir:entry.stateDir,opts:{},projectId:entry.projectId};
        break;
      }
    } else if(parsed.project&&!parsed.opts['--state']) {
      const entry=await api.lookupProject({home,project:parsed.project});
      if(entry)parsed={...parsed,stateDir:entry.stateDir,projectId:entry.projectId};
    }
    stateDir=parsed.stateDir;
    const openingStatus=parsed.projectId?await api.projectStatus({stateDir}):null;
    if(openingStatus&&openingStatus.projectId!==parsed.projectId)throw new Error('REGISTRY_IDENTITY_CHANGED');
    const showChecks=checks=>{for(const c of checks??[]){say(`${c.stage??'Python 測試'}：${c.status}${c.code&&c.status!=='passed'?`（${c.code}）`:''}`);const summary=(c.stderr??'').match(/Ran \d+ tests? in [^\n]+/);if(summary)say(summary[0]);if(c.status!=='passed')say((c.stderr||c.stdout||'沒有診斷輸出').slice(0,4000));}};
    const execute = async (p) => {
      const o = p.opts || {};
      switch (p.command) {
        case 'help': say(HELP+'\n'+OUTPUT_HELP); return 0;
        case 'init': {
          const repo = resolve(o['--repo']);
          const profile=o['--profile']?api.validateProfile(JSON.parse(await readFile(o['--profile'],'utf8'))):undefined;
          const routing=o['--routing']?api.validateRouting(JSON.parse(await readFile(o['--routing'],'utf8'))):undefined;
          const sourceFiles=profile?.sourceFiles??await api.thorSourceFiles(repo);
          const context = await api.loadProjectContext({repo,sourceFiles});
          const status = await api.createProject({stateDir,repo,sourceFiles,context,profile,routing,backend:o['--backend']??'agy',model:o['--model'],effort:o['--effort'],seedContents:o['--seed'] ? await seedContents(o['--seed']) : {}});
          if(p.project){
            try{await api.registerProject({home,project:p.project,stateDir});}
            catch(e){say(`工作區已建立於 ${stateDir}，登錄失敗；請保留此路徑，不要重做 init。`);throw e;}
          }
          showStatus(status); say('已建立隔離工作區。尚未授權模型資源；請明確執行 authorize。'); return 0;
        }
        case 'register':
          await api.projectStatus({stateDir});
          resultData=await api.registerProject({home,project:p.project,stateDir});
          say(`已登錄 ${p.project}。直接執行 calcifer 選擇，或 calcifer --project ${p.project} 接續。模型授權與額度未變更。`);return 0;
        case 'status': showStatus(p===parsed&&openingStatus?openingStatus:await api.projectStatus({stateDir})); return 0;
        case 'revise':{
          const note=o['--note-file']?await inputText(o['--note-file'],32000):o['--note'];
          if(!note?.trim()||note.length>8000)throw usage('修訂說明不可空白，且最多 8000 字元。');
          showStatus(await api.revisePreparedProject({stateDir,note}));
          say('已記錄具體修訂並保留舊成果；沒有呼叫模型或重設額度。用 start 接續同一 worker 並交付，或用 resume 只接續工作。');return 0;
        }
        case 'files':{
          const s=await api.projectStatus({stateDir});resultData={status:s.status,code:s.code,workspaceError:s.workspaceError??null,files:s.files??[],changedFiles:s.changedFiles??[]};
          if(s.workspaceError){resultError={code:s.workspaceError,message:'無法讀取工作區檔案，請先處理回報的原因。'};say(resultError.message);return 1;}
          say(resultData.files.join('\n')||'目前沒有可列出的檔案。');return 0;
        }
        case 'result':{
          const r=await api.readProjectResult({stateDir});showStatus(r);resultData=r;
          say(`測試證據對應目前工作區：${r.checksCurrent?'是':'否或尚未驗證'}`);
          for(const a of r.artifacts.patches)say(`補丁：${a.patchPath} · 完整性 ${a.verified?'通過':'未通過'} · ${a.current?'對應目前成果':'歷史或不符目前成果'}`);
          if(r.artifacts.documents){const d=r.artifacts.documents;say(`文件：${d.status} · ${d.pages} 頁\nWord：${d.docxPath}\nPDF：${d.pdfPath}\n對應目前成果：${d.current?'是':'否'}`);}
          for(const w of r.artifacts.warnings)say(`交付物診斷：${w.kind} ${w.code}`);
          say('這是現有證據查詢；不代表人工接受、已整合、推送或正式送件。');return 0;
        }
        case 'prepare':{
          const task=await inputText(o['--task-file']);if(!task.trim())throw usage('需求檔案不可空白。');
          const documents=o['--documents']?JSON.parse(await inputText(o['--documents'],16384)):null;
          const r=await api.prepareProjectTask({stateDir,title:o['--title'],task,maxTurns:Number(o['--turns']),note:o['--note'],documents});
          resultData={title:r.title,hash:r.hash,maxTurns:r.maxTurns,delivery:r.documents===null?'patch':'documents',authorized:false};
          say(`已準備：${r.title}\n任務 SHA256：${r.hash}\n尚未授權模型；確認範圍後以 start 啟動。`);return 0;
        }
        case 'start': {
          const prepared=await api.readPreparedTask({stateDir});
          if(!prepared)throw usage('這個專案尚未配置準備好的目標；可用 work 明確指定需求。');
          let current=await api.projectStatus({stateDir});
          if(current.pending)throw new Error('PROJECT_PENDING');
          if(current.goal&&current.goal.task!==prepared.task)throw new Error('PREPARED_GOAL_MISMATCH');
          if(current.goal?.status==='completed')return execute({command:'deliver'});
          say(`已準備：${prepared.title}${machine?'':'\n'+prepared.task}`);
          if(current.maxTurns==null||current.maxTurns===0){
            const authorized=await execute({command:'authorize',opts:{'--turns':String(prepared.maxTurns),'--note':prepared.note,...(o['--yes']?{'--yes':true}:{})}});
            if(authorized!==0)return authorized;
            current=await api.projectStatus({stateDir});
          }
          if(current.maxTurns>prepared.maxTurns||current.authorization!==prepared.note)throw new Error('PREPARED_AUTHORIZATION_MISMATCH');
          if(current.turnsUsed>=current.maxTurns)throw new Error('RESOURCE_LIMIT');
          const result=await execute({command:current.goal?.status==='failed'?'resume':'work',task:prepared.task});
          if(result!==0)return result;
          return execute({command:'deliver'});
        }
        case 'deliver': {
          const prepared=await api.readPreparedTask({stateDir});
          if(prepared?.documents===null){
            const current=await api.projectStatus({stateDir});
            if(current.pending)throw new Error('PROJECT_PENDING');
            if(current.goal?.status!=='completed'||current.goal.task!==prepared.task)throw new Error('GOAL_INCOMPLETE');
            if(!current.goal.results?.length||current.goal.results.some(r=>r.completion?.status!=='complete'||!r.completion.inputContextHash))throw new Error('DOCUMENT_SOURCE_ACK_REQUIRED');
            const result=await api.exportProject({stateDir});
            capture({...result,status:'completed'});
            say(`程式交付：已驗證 patch\n補丁：${result.patchPath}\nSHA256：${result.patchHash}\n主機檢查通過；尚未套用、提交或合併到來源專案。`);
            return 0;
          }
          controller=new AbortController();activePhase='document';say('正在產生企劃草稿 DOCX／PDF 與交付紀錄；不呼叫模型。');
          try{
            const result=await api.deliverProjectDocuments({stateDir,signal:controller.signal});
            capture(result);
            say(`文件交付：${result.status}\nWord：${result.docxPath}\nPDF：${result.pdfPath}\n頁數：${result.pages}\n交付目錄：${result.directory}\n仍須核對正式隊伍資料、真實影片與逐頁內容；尚未報名或送件。`);
            return 0;
          }finally{controller=undefined;activePhase=undefined;}
        }
        case 'authorize': {
          const current=await api.projectStatus({stateDir});
          const candidates=current.routing?current.routing.profiles.filter(p=>p.enabled).map(p=>`${p.id}: ${p.execution.backend}/${p.execution.model}/${p.execution.effort} (${p.resource==='existing-credits'?'允許扣用既有 credits':p.resource}, 最多 ${p.maxCalls} 次)`).join('；'):`${current.backend??'agy'} / ${current.model}`;
          const duration=o['--minutes']===undefined?'不設執行期限':`${o['--minutes']} 分鐘，首次派送才計時`;
          say(`授權範圍：${candidates}；專案 ${current.projectName??current.projectId} 的隔離檔案、必要規則與需求。規劃、實作、修正合計上限 ${o['--turns']} 次呼叫；${duration}。不切帳號；僅使用已列出的供應商與既有資源，不購買額度或兌換 reset。${current.routing?'路由設定會綁定本階段授權。':'既有帳號是否允許額外扣點須由你先確認。'}`);
          if (!o['--yes']) {
            if (machine||!input.isTTY || !output.isTTY) {const e=usage('非互動環境不會等待確認。請核對範圍後明確加入 --yes。');e.reasonCode='CONFIRMATION_REQUIRED';throw e;}
            if ((await question('輸入 yes 才授權：')).trim() !== 'yes') { say('未授權。'); return 2; }
          }
          const status = await api.authorizeProject({stateDir,maxTurns:Number(o['--turns']),maxMinutes:o['--minutes']===undefined?null:Number(o['--minutes']),note:o['--note']});
          showStatus(status); return 0;
        }
        case 'work': case 'resume': {
          const task=o['--task-file']?await inputText(o['--task-file']):p.task;
          if(p.command==='work'&&!task?.trim())throw usage('需求不可空白。');
          controller = new AbortController(); const started = Date.now(),seen=new Set();
          say('正在接續所選專案工作區；使用 Ctrl-C 取消。');
          const heartbeat=setInterval(()=>{transport.event('heartbeat',{elapsedSeconds:Math.floor((Date.now()-started)/1000)});if(format!=='jsonl')say(`[${Math.floor((Date.now()-started)/1000)} 秒] 工作仍在進行，尚未收到完成結果。`);},30000);
          try {
            const run=p.command==='resume'?api.resumeProjectGoal:api.workProject;
            const r = await run({stateDir,task,signal:controller.signal,onEvent:e=> {
              if(e?.event==='route'){transport.event('route',{taskId:e.taskId??null,profileId:e.profileId,execution:{backend:e.execution?.backend,model:e.execution?.model,effort:e.execution?.effort}});say(`任務分配：${e.taskId??'規劃'} → ${e.execution.model} / ${e.execution.effort}（${e.profileId}）`);return;}
              const kind = typeof e === 'string' ? e : e?.event==='dispatch'?'dispatch':e?.event==='checks'?'checks':e?.itemType??e?.type;
              const key=`${kind}:${e?.index??e?.attempt??''}`;if(!kind||seen.has(key)||['agent_response','user_input','system_message'].includes(kind))return;seen.add(key);
              const labels = {dispatch:'派送模型',checks:'主機執行 Python 測試',view_file:'讀取檔案',list_dir:'查看目錄',find_by_name:'尋找檔案',grep_search:'搜尋程式',write_to_file:'新增檔案',replace_file_content:'修改檔案',multi_replace_file_content:'修改檔案',command_execution:'執行隔離命令',file_change:'修改檔案'};
              if(labels[kind]){transport.event(kind,{elapsedSeconds:Math.floor((Date.now()-started)/1000),...(kind==='dispatch'?{model:e.model,effort:e.effort,used:e.used,max:e.max,attempt:e.attempt}:{})});say(`[${Math.floor((Date.now()-started)/1000)} 秒] ${labels[kind]}${kind==='dispatch'?`：${e.model??''} ${e.effort??''}，合計 ${e.used}/${e.max}`:''}`);}
            }});
            say(`工作結果：${r.status}`); if (r.response) say(typeof r.response === 'string' ? r.response : '模型回覆已保存，請查看狀態。');
            if(r.code&&r.status!=='completed')say(`原因：${r.code}`);showChecks(r.checks);
            const ok=['complete','completed','passed','ready','succeeded'].includes(r.status);capture(r,!ok);return ok?0:1;
          } finally { clearInterval(heartbeat);controller = undefined; }
        }
        case 'test': {
          controller = new AbortController();
          try { const r = await api.testProject({stateDir,signal:controller.signal,force:Boolean(o['--force'])}); say(`測試：${r.status}${r.reused?'（沿用同一快照證據）':''}`); showChecks(r.checks); const ok=['passed','complete','completed','ready'].includes(r.status);capture(r,!ok);return ok?0:1; }
          finally { controller = undefined; }
        }
        case 'diff': {const diff=await api.projectDiff({stateDir});resultData={diff};say(diff);return 0;}
        case 'export': { const r = await api.exportProject({stateDir,output:o['--output']});capture(r);say(`已匯出：${r.patchPath}\nSHA256：${r.patchHash}`); return 0; }
        case 'recover': showStatus(await api.reconcileProject({stateDir})); return 0;
        case 'abandon': showStatus(await api.abandonProjectGoal({stateDir,note:o['--note']}));say('已保存放棄紀錄與現有修改；預算未重設。下一個目標仍須在已授權範圍內。');return 0;
      }
    };
    if (parsed.command !== 'repl') return finish(await execute(parsed));
    showStatus(openingStatus??await api.projectStatus({stateDir}),true);
    if (!input.isTTY || !output.isTTY) { say('非互動模式；使用 work "需求"，或 --help 查看命令。'); return 0; }
    const prepared=api.readPreparedTask?await api.readPreparedTask({stateDir}):null;
    if(prepared)say(`已準備：${prepared.title}。輸入 /start，確認一次資源後持續執行並交付成果；完成就停止。請保持終端與主機運作，這不是背景服務。`);
    else say('輸入需求即可接續工作，/help 查看指令。新工作階段不會自動授權。');
    ensureReadline();
    while (!rl.closed) {
      let line; try { line = (await question(`calcifer ${parsed.project??'project'}> `)).trim(); } catch { break; }
      if (!line) continue; if (line === '/quit' || line === '/exit') break;
      try {
        if (line === '/files') { const s=await api.projectStatus({stateDir}); say((s.files || s.changedFiles || []).map(f=>typeof f==='string'?f:f.path).join('\n') || '目前沒有可列出的檔案。'); continue; }
        let next;
        if (line.startsWith('/authorize ')) { const parts=line.split(/\s+/); if(parts.length<2||parts.length>3) throw usage('用法：/authorize 次數 [分鐘]，省略分鐘表示不設期限'); next=parseArgs(['authorize','--turns',parts[1],...(parts.length===3?['--minutes',parts[2]]:[]),'--note','互動終端明確授權','--state',stateDir]); }
        else if(line.startsWith('/abandon '))next={command:'abandon',opts:{'--note':line.slice(9).trim()}};
        else if(line.startsWith('/')) { const cmd=line.slice(1); if(!['help','status','test','diff','export','recover','resume','start','deliver'].includes(cmd)) throw usage('未知互動指令；輸入 /help 查看。'); next={command:cmd,opts:{}}; }
        else next={command:'work',task:line,opts:{}};
        await execute(next);
      } catch (e) { errors.write(errorText(e)+'\n'); }
    }
    return 0;
  } catch (e) { resultError={code:errorCode(e),message:errorText(e)};errors.write(errorText(e)+'\n');return finish(e.code==='CLI_USAGE'?2:1); }
  finally { rl?.close(); proc.removeListener('SIGINT',interrupted);proc.removeListener('SIGTERM',interrupted); }
}
function errorText(e) {
  if (e?.code === 'ENOENT') return '尚未建立工作階段或必要檔案不存在。請先執行 calcifer init --repo /專案路徑 --profile /設定.json --backend codex或agy --project 名稱，並核對 --state。';
  if (e?.name === 'AbortError') return '工作已取消；結果可能未知，請使用 recover 核對，不會自動重送。';
  const messages={DOCUMENT_SOURCE_ACK_REQUIRED:'原成果缺少來源送入與完整性確認，不能再當作驗收完成交付。請保留原稿並進行具體修正；不會重設額度或自動重送。',PREPARED_GOAL_MISMATCH:'這個工作階段的目標與已準備需求不同；保留原任務，不自動替換。',PREPARED_AUTHORIZATION_MISMATCH:'現有授權與已準備的資源階段不符，不會自動重設或派送。',PREPARED_SCOPE_CHANGED:'已準備的專案或模型範圍有變動，停止啟動並保留原狀態。',DOCUMENT_RENDER_FAILED:'文件轉換失敗，診斷已保留。模型成果仍在；修正環境後用 /deliver 重試，不需重跑模型。',REGISTRY_IDENTITY_CHANGED:'已登錄工作階段的身分已改變，停止開啟；請核對原路徑，不會自動換一份。',REGISTRY_NAME_CONFLICT:'專案名稱已指向其他工作階段；請換一個名稱登錄，不會覆寫原資料。',REGISTRY_STATE_MISSING:'已登錄的工作階段不在原路徑，請核對原檔案；不會另建或重送任務。',AUTHORIZATION_REQUIRED:'尚無本階段模型授權。確認供應商與資料後，以 /authorize 次數 [分鐘] 設定資源上限；省略分鐘表示不設期限。',RESOURCE_LIMIT:'本階段呼叫次數或明確設定的期限已用完。成果已保存；下一階段須由你重新明確授權。',PROJECT_PENDING:'上一請求的結果尚未核對，不會重送。先用 /recover 或 status 查看原始請求。',PROJECT_BUSY:'這個工作區已有另一個操作在執行，請等該操作完成。',AGY_VERSION_CHANGED:'agy 版本已改變，必須先重新核對接入契約，沒有送出新任務。',AUTHORIZATION_ALREADY_ACTIVE:'既有授權仍有效，不會重設已使用次數。',PROJECT_EXISTS:'工作階段已存在。使用相同 --project 或 --state 即可接續。'};if(messages[e?.message])return messages[e.message];
  return `無法完成：${safe(e?.message || '未知錯誤').split('\n')[0].slice(0,500)}`;
}
