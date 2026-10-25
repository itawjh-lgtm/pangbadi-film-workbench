import {APIError,json,uid,now,requireId,requireProject,digest,stable,type Context} from './core';
import {startTextRun,advanceTextRun,cancelTextRun,assertTextVisible,textHealth} from './text';

const VISUAL = `依据当前剧本交付角色、世界和美术设定。先列人物资产总表，每位作品角色用稳定 CHR-001 编号，再以“### CHR-001｜角色名”分别写完整人物卡。人物卡包含人物介绍、身份与年龄、外貌身形五官、发型、服装配饰、辨识特征、性格与表演、定妆视图、参考图生成提示词、不可改变项、换装版本、出场关联、依据与性质。人物介绍是剧情简介，与生成提示词分开。未知原作事实标待核实，年龄无来源标创作建议。人物定妆提示词须具体可执行、无文字、统一造型，禁止写成镜头剧情动作。场景和道具分别用 SCN-/PROP-编号，不能混入人物。制作员工 R01—R16 不属于作品人物。纯场景项目明确无需人物资产，不能凑人物。分镜尚未编排时关联剧本场次，不伪造已确认镜号。正文末尾附一个严格 JSON 代码块：{"characters":[{"id":"CHR-001","name":"角色姓名","description":"两三句人物介绍","imagePrompt":"完整定妆提示词","appearance":"外貌","hair":"发型","costume":"服装","immutableTraits":"不可改变项","sourceBasis":"用户提供/剧本设定/创作建议/待核实"}]}。无人物时 characters 为 []。JSON 与正文一一对应，不用示例占位值。`;
const SHOT_JSON = `正文后附严格 JSON 代码块：{"shots":[{"id":"S001","title":"镜头名称","description":"画面描述","timing":"0–5 秒","durationSeconds":5,"imagePrompt":"本镜生图提示词","videoPrompt":"本镜视频运动提示词","characterIds":["CHR-001"],"sceneIds":["SCN-001"]}]}。ID沿用上游；仅引用真实设定角色。每镜提示词包含本镜有效内容，不机械重复整段人物设定。JSON 与正文一致，不填写示例占位值。`;
export const STAGES = [
  {id:'plan',title:'制作规划',agentId:'R11',instruction:'把本项目要求转成具体制作简报：主题、受众、时长、叙事目标、交付范围、必须保持的约束与待核资料。给编剧可直接使用的创作方向，不再设计员工组织架构。'},
  {id:'script',title:'剧本创作',agentId:'R03',instruction:'依据简报交付可连续阅读的完整剧本，包含情节、人物、场景、对白或旁白及大致时长。不能只给大纲或提示词。缺失事实标待核实，原创设计与原作事实分开。'},
  {id:'visual',title:'角色与视觉设定',agentId:'R05',instruction:VISUAL},
  {id:'storyboard',title:'逐镜设计',agentId:'R04',instruction:'根据当前剧本和角色美术设定写完整逐镜 Markdown 表：镜号、时长、画面、动作、景别、运镜、对白旁白、声画意图。核对总时长，保持故事和角色一致。文稿不等于已制作预演。'+SHOT_JSON},
  {id:'prompts',title:'生图与视频输入',agentId:'R06',instruction:'依据当前逐镜稿逐镜给出可直接使用的生图和视频动作提示词、引用人物/场景、参考图要求、首尾帧意图、比例及清晰度建议和缺失输入。沿用镜号、人物编号、镜头数量和时长，不遗漏镜头。禁止假称已经连接模型或生成素材。'+SHOT_JSON},
  {id:'delivery',title:'交付整理与检查',agentId:'R11',instruction:'汇总本轮实际交付的剧本、美术、分镜和提示词，检查冲突和缺失，指出镜号及下一步动作。缺失结构化数据要明确指出。仅是文字检查建议，不得声称独立专业复核、实际生成、播放验收或发布完成。'},
];
const UNFINISHED=['running','awaiting_review','paused','failed'];
function current(plan:any){return plan.stages.find((s:any)=>s.status!=='completed');}
function emit(plan:any,type:string,text:string,stage?:any){plan.events.push({seq:plan.events.length+1,id:uid(),type,text,at:now(),stageId:stage?.id||null,agentId:stage?.agentId||null});}
function needsReview(plan:any,stage:any){return stage.id==='delivery'||plan.reviewMode==='stepwise'&&['script','visual'].includes(stage.id);}
function readiness(plan:any){plan.currentStageId=current(plan)?.id||null;const ready=plan.stages.some((s:any)=>s.id==='prompts'&&s.status==='completed'&&s.artifacts.length);plan.mediaReadiness={status:ready?'inputs_prepared':'not_started',label:ready&&plan.status==='completed'?'文稿已确认，先完成人物资产，再制作分镜图片和视频。':ready?'生成输入已准备，等待文稿确认。':'团队正在准备剧本、角色与逐镜生成输入。',imagesGenerated:false,videosGenerated:false};return plan;}
async function save(ctx:Context,plan:any){return ctx.store.put('production',readiness(plan),plan.revision);}
async function visible(ctx:Context,plan:any){await assertTextVisible(ctx,'production',plan.id,plan.projectId);const markers=await ctx.store.list('trash'),copy=structuredClone(plan);delete copy.requestHash;const hidden=(a:any)=>markers.some((t:any)=>!t.restoredAt&&(t.kind==='artifact'&&t.targetId===a.id||t.kind==='run'&&t.targetId===a.runId));for(const s of copy.stages){s.artifacts=s.artifacts.filter((a:any)=>!hidden(a));for(const h of s.history||[])h.artifacts=(h.artifacts||[]).filter((a:any)=>!hidden(a));}return readiness(copy);}
async function existingPlan(ctx:Context,id:string){const plan=await ctx.store.require('production',requireId(id));await requireProject(ctx,plan.projectId);await assertTextVisible(ctx,'production',plan.id,plan.projectId);return plan;}
function revision(plan:any,data:any){if(!Number.isInteger(data?.expectedRevision)||plan.revision!==data.expectedRevision)throw new APIError('制作进度已更新，请查看最新版本后重试。',409);}
function archive(stage:any){if(stage.runId||stage.requestId||stage.artifacts.length)stage.history.push({attempt:stage.attempt,runId:stage.runId,requestId:stage.requestId,status:stage.status,inputArtifactIds:stage.inputArtifactIds,outputArtifactIds:stage.outputArtifactIds,artifacts:stage.artifacts,error:stage.error,review:stage.review,archivedAt:now()});Object.assign(stage,{runId:null,requestId:null,inputArtifactIds:[],outputArtifactIds:[],artifacts:[],error:null,review:null});}

export async function startProduction(ctx:Context,data:any) {
  requireId(data?.requestId);const hash=await digest(stable(data)),prior=await ctx.store.byRequest('production',data.requestId);
  if(prior){await assertTextVisible(ctx,'production',prior.id,prior.projectId);if(prior.requestHash!==hash)throw new APIError('同一请求编号不可改变内容后重用。',409);return prior;}
  const project=await requireProject(ctx,data.project?.id);if(project.kind==='game')throw new APIError('自动影视流程用于影视项目，游戏项目请使用角色工位。');
  if(typeof data.prompt!=='string'||!data.prompt.trim()||data.prompt.length>16000)throw new APIError('请提供不超过 16000 字的制作要求。');
  const reviewMode=data.reviewMode||'stepwise';if(!['stepwise','continuous'].includes(reviewMode))throw new APIError('请选择逐步审核或连续协作。');
  if(!textHealth(ctx.settings).available)throw new APIError('请先配置个人文字模型 API Key。',503);
  if((await ctx.store.list('production')).some((p:any)=>p.projectId===project.id&&UNFINISHED.includes(p.status)))throw new APIError('本项目已有未完成的自动协作，请继续已有计划。',409);
  const id=uid(),lock=await ctx.store.get('production-scope',project.id);if(lock?.productionId){const p=await ctx.store.get('production',lock.productionId);if(p&&UNFINISHED.includes(p.status)||!p&&now()-lock.updatedAt<120000)throw new APIError('项目正在提交自动协作，请稍后刷新。',409);}
  await ctx.store.put('production-scope',{id:project.id,productionId:id},lock?.revision||0);
  const plan:any={id,requestId:data.requestId,requestHash:hash,projectId:project.id,project,prompt:data.prompt.trim(),reviewMode,status:'running',createdAt:now(),stages:STAGES.map((s,i)=>({id:s.id,title:s.title,agentId:s.agentId,dependsOn:i?[STAGES[i-1].id]:[],status:'pending',runId:null,requestId:null,attempt:0,inputArtifactIds:[],outputArtifactIds:[],artifacts:[],history:[],error:null,review:null,revisionNote:''})),events:[],error:null,evidenceLevel:'text_production'};
  emit(plan,'created','制作需求已保存；轮询将推进真实文字协作。');const saved=await ctx.store.create('production',readiness(plan));if(saved)return saved;const p=await ctx.store.byRequest('production',data.requestId);if(p?.requestHash===hash)return p;throw new APIError('制作请求提交冲突，请刷新。',409);
}

async function inputIds(ctx:Context,plan:any,stage:any){const ids:string[]=[];for(const source of plan.stages){if(source.id===stage.id)break;if(source.status!=='completed')throw new APIError('上游文稿尚未确认。',409);ids.push(...source.outputArtifactIds);}if(stage.revisionNote){const prior=[...stage.history].reverse().find((h:any)=>h.artifacts?.length);ids.push(...(prior?.artifacts||[]).map((a:any)=>a.id));}for(const id of new Set(ids)){const a=await ctx.store.require('artifact',id);if(a.projectId!==plan.projectId||a.peerId)throw new APIError('不能交接其他项目的文稿。',409);await assertTextVisible(ctx,'artifact',a.id,plan.projectId);await assertTextVisible(ctx,'run',a.runId,plan.projectId);}return [...new Set(ids)];}
function stagePayload(plan:any,stage:any){const definition=STAGES.find(s=>s.id===stage.id)!;return {requestId:stage.requestId,project:plan.project,agentIds:[stage.agentId],mode:'produce',prompt:stage.title+' · 第'+stage.attempt+'版 · '+plan.project.title+'\n本项目制作要求：\n'+plan.prompt+'\n\n本阶段职责：\n'+definition.instruction+'\n\n交付完整中文正文，依据已保存的前序成果，不编造外部查证或媒体结果。'+(stage.revisionNote?'\n\n总策划返修要求（提供了上版全文）：\n'+stage.revisionNote:''),inputArtifacts:stage.inputArtifactIds.map((id:string)=>({id})),history:[],tasks:[],decisions:[],productionId:plan.id,productionStageId:stage.id};}
function consume(plan:any,stage:any,run:any){if(run.status!=='succeeded'||!run.artifacts?.length)return false;stage.artifacts=structuredClone(run.artifacts);stage.outputArtifactIds=stage.artifacts.map((a:any)=>a.id);stage.status=needsReview(plan,stage)?'awaiting_review':'completed';stage.error=null;plan.error=null;plan.outcomeUnknown=false;emit(plan,'delivered',stage.title+' 已保存完整文字成果。',stage);if(stage.status==='awaiting_review'){if(plan.status!=='paused')plan.status='awaiting_review';emit(plan,'review_required','等待总策划审阅此版本。',stage);}return true;}

/** Poll-driven progression: at most one provider call and one stage per request. */
export async function advanceProduction(ctx:Context,id:string) {
  let plan=await existingPlan(ctx,id);if(plan.status!=='running')return plan;
  let stage=current(plan);if(!stage)return plan;
  if(stage.status==='awaiting_review'){plan.status='awaiting_review';return save(ctx,plan);}
  const stageId=stage.id;
  try {
    if(['pending','stale'].includes(stage.status)){
      const occupied=(await ctx.store.list('run')).some((r:any)=>r.projectId===plan.projectId&&['queued','running'].includes(r.status));if(occupied)return plan;
      stage.inputArtifactIds=await inputIds(ctx,plan,stage);stage.attempt++;stage.requestId='production-'+plan.id+'-'+stage.id+'-'+stage.attempt;stage.runId=uid();stage.status='running';emit(plan,'dispatched',stage.agentId+' 已收到本阶段要求及前序正式文稿。',stage);plan=await save(ctx,plan);stage=current(plan);
    }
    if(!stage||stage.status!=='running')return plan;
    let run=await ctx.store.get('run',stage.runId);
    if(!run)run=await startTextRun(ctx,stagePayload(plan,stage),{productionId:plan.id,stageId:stage.id,runId:stage.runId});
    if(run.projectId!==plan.projectId||run.productionId!==plan.id||run.productionStageId!==stage.id)throw new APIError('运行与制作阶段不匹配。',409);
    const requestId=stage.requestId;run=await advanceTextRun(ctx,run.id);
    const latest=await existingPlan(ctx,id),currentStage=latest.stages.find((s:any)=>s.id===stageId);
    if(currentStage?.requestId!==requestId)return latest;
    if(consume(latest,currentStage,run))return save(ctx,latest);
    if(['failed','cancelled'].includes(run.status)){currentStage.status=latest.status==='paused'?'paused':'failed';currentStage.error=run.error||'本阶段已停止，已有文字保留。';latest.status=latest.status==='paused'?'paused':'failed';latest.error=currentStage.error;latest.outcomeUnknown=Boolean(run.outcomeUnknown);emit(latest,'failed',latest.error,currentStage);return save(ctx,latest);}
    return latest;
  }catch(error){if(error instanceof APIError&&error.status===409)return existingPlan(ctx,id);const latest=await existingPlan(ctx,id);const s=current(latest);if(latest.status!=='running'||s?.id!==stageId)return latest;latest.status='failed';latest.error=error instanceof APIError?error.message:'本阶段未完成，已保存成果保留；请刷新核对。';if(s){s.status='failed';s.error=latest.error;}emit(latest,'failed',latest.error,s);return save(ctx,latest);}
}

async function mutate(ctx:Context,id:string,action:string,data:any) {
  let plan=await existingPlan(ctx,id);revision(plan,data);let stage=current(plan);
  if(action==='pause'){
    if(plan.status==='completed')throw new APIError('计划已完成，无需暂停。',409);if(plan.status==='paused')return plan;
    plan.status='paused';emit(plan,'paused','已暂停后续协作；已发出的模型请求可能继续完成并计费，结果会保留。',stage);return save(ctx,plan);
  }
  if(action==='resume'){
    if(!['paused','failed'].includes(plan.status))throw new APIError('请从暂停或失败的计划继续；待审阅版本请先审阅。',409);
    if(plan.outcomeUnknown&&data.confirmUnknown!==true)throw new APIError('上次模型请求结果未知，可能已计费。核对服务商记录后，确认重新执行才能继续。',409);
    if(stage){const run=stage.runId?await ctx.store.get('run',stage.runId):null;if(run?.status==='succeeded')consume(plan,stage,run);stage=current(plan);
      if(stage?.status==='awaiting_review')plan.status='awaiting_review';else if(stage){const currentRun=stage.runId?await ctx.store.get('run',stage.runId):null;if(!currentRun||!['queued','running'].includes(currentRun.status)){archive(stage);stage.status='pending';}plan.status='running';}else plan.status='completed';
    }else plan.status='completed';plan.error=null;plan.outcomeUnknown=false;emit(plan,'resumed','已继续未完成阶段，已确认版本保留。',stage);return save(ctx,plan);
  }
  if(action!=='review')throw new APIError('操作不存在。',404);
  if(!['approve','revise'].includes(data.action))throw new APIError('请选择确认或返修。');stage=plan.stages.find((s:any)=>s.id===data.stageId);if(!stage)throw new APIError('制作阶段不存在。',404);
  const note=data.note||'';if(typeof note!=='string'||note.length>2000)throw new APIError('审阅意见不能超过 2000 字。');for(const a of stage.artifacts)await assertTextVisible(ctx,'artifact',a.id,plan.projectId);
  if(data.action==='approve'){
    if(stage.status!=='awaiting_review'||!stage.artifacts.length)throw new APIError('只能确认当前待审阅的真实交付。',409);
    stage.review={action:'approve',note:note.trim(),at:now(),artifactIds:[...stage.outputArtifactIds],reviewer:'user'};stage.status='completed';if(!current(plan))plan.status='completed';else if(plan.status!=='paused')plan.status='running';emit(plan,'approved','总策划已确认此文字版本。',stage);return save(ctx,plan);
  }
  if(!note.trim()||!stage.artifacts.length)throw new APIError('取得文稿后，请填写具体返修要求。');
  const index=plan.stages.indexOf(stage),cancelIds:string[]=[];
  for(const target of plan.stages.slice(index)){if(target.runId)cancelIds.push(target.runId);archive(target);target.status=target===stage?'pending':'stale';target.revisionNote=target===stage?note.trim():'';}
  stage.review={action:'revise',note:note.trim(),at:now(),reviewer:'user'};plan.status='running';plan.error=null;plan.outcomeUnknown=false;emit(plan,'revision_requested','已记录返修要求；后续阶段按新版本重做，历史文稿保留。',stage);
  plan=await save(ctx,plan);for(const runId of cancelIds){const run=await ctx.store.get('run',runId);if(run&&['queued','running'].includes(run.status))await cancelTextRun(ctx,runId);}return plan;
}

export async function productionRoute(ctx:Context,path:string,method:string,data:any):Promise<Response|null> {
  if(method==='POST'&&path==='/api/productions')return json({production:await visible(ctx,await startProduction(ctx,data))},202);
  if(method==='GET'&&path==='/api/productions'){
    const projectId=new URL(ctx.request.url).searchParams.get('projectId');await requireProject(ctx,requireId(projectId));let all=(await ctx.store.list('production')).filter((p:any)=>p.projectId===projectId);const trash=await ctx.store.list('trash');all=all.filter((p:any)=>!trash.some((t:any)=>!t.restoredAt&&t.kind==='production'&&t.targetId===p.id));
    const active=all.find((p:any)=>p.status==='running');if(active){const updated=await advanceProduction(ctx,active.id);all=all.map((p:any)=>p.id===active.id?updated:p);}
    return json({productions:await Promise.all(all.map((p:any)=>visible(ctx,p)))});
  }
  if(method==='GET'&&/^\/api\/productions\/[-\w]+$/.test(path))return json({production:await visible(ctx,await advanceProduction(ctx,path.split('/')[3]))});
  if(method==='POST'&&/^\/api\/productions\/[-\w]+\/(pause|resume|review)$/.test(path)){const parts=path.split('/');return json({production:await visible(ctx,await mutate(ctx,parts[3],parts[4],data))});}
  return null;
}
