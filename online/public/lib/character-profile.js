/* Read-only character introductions. Generation prompts are never a biography. */
(function(global){
  'use strict';
  const EMPTY='暂无人物介绍，可在角色设定中补充身份、性格与剧情作用。';
  const introTitles=['人物介绍','角色介绍','人物简介','角色简介','人物小传','角色小传','角色概述','人物概述','人物定位','角色定位','角色视觉命题','数量与功能'];
  const labels={identityAge:['身份与年龄','身份年龄','身份','年龄观感'],performance:['性格与表演','性格','人物性格','气质与表演']};
  const clean=value=>String(value??'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/<[^>]*>/g,'').replace(/[`*_]/g,'').replace(/^\s*(?:>\s*|[-+]\s+|\d+[.)、]\s*)/gm,'').replace(/\s+/g,' ').trim();
  const title=value=>clean(value).replace(/^[一二三四五六七八九十百\d]+[.、．)）]\s*/,'').replace(/[：:]$/,'').trim();
  const generationText=value=>/(?:提示词|生成要求|负面词|负向词|分辨率|渲染|[248]K\b|--ar\b|seed\s*[:：]|正面.{0,30}侧面.{0,30}背面|无字定妆|不要生成文字|高清出图)/i.test(value);
  const sourceNotice=value=>/(?:本版只服务|尚未生成|未生成|待审图|依据与性质|原作.{0,30}待核实|原作.{0,30}均待|输入版本|资产编号|来源版本)/.test(value);
  function clip(value){
    const text=clean(value);if(text.length<=240)return text;
    const first=text.slice(0,240),stop=Math.max(first.lastIndexOf('。'),first.lastIndexOf('；'));
    return stop>=120?first.slice(0,stop+1):first+'…';
  }
  function prose(block){
    return String(block||'').split(/\n\s*\n/).map(part=>part.split('\n').filter(line=>{
      const trimmed=line.trim();return trimmed&&!/^\s*(?:#{1,6}\s|\||```|---+$|>)/.test(trimmed)&&!generationText(trimmed)&&!sourceNotice(trimmed);
    }).map(clean).join(' ')).filter(Boolean).slice(0,2).join(' ');
  }
  function sections(body){
    const lines=String(body||'').split('\n'),found=[];
    for(let index=0;index<lines.length;index++){
      const match=lines[index].match(/^\s*#{1,6}\s+(.+)$/);if(!match)continue;
      let end=index+1;while(end<lines.length&&!/^\s*#{1,6}\s+/.test(lines[end]))end++;
      found.push({title:title(match[1]),body:lines.slice(index+1,end).join('\n')});
    }
    return found;
  }
  function inline(body,names){
    for(const line of String(body||'').split('\n')){
      const cells=line.trim().startsWith('|')?line.trim().replace(/^\||\|$/g,'').split('|').map(clean):null;
      if(cells?.length===2&&names.includes(title(cells[0])))return clean(cells[1]);
      const match=clean(line).match(/^([^：:]{1,24})[：:]\s*(.+)$/);
      if(match&&names.includes(title(match[1])))return clean(match[2]);
    }
    return '';
  }
  function summary(asset={}){
    const body=String(asset.description||''),parts=sections(body);
    for(const candidate of [asset.introduction,asset.fields?.introduction,inline(body,introTitles),...introTitles.map(name=>prose(parts.find(part=>part.title===name)?.body))]){
      if(typeof candidate==='string'&&candidate.trim()&&!generationText(candidate))return clip(candidate);
    }
    const facts=Object.entries(labels).map(([field,names])=>{
      const value=asset.fields?.[field]||inline(body,names)||prose(parts.find(part=>names.includes(part.title))?.body);
      return typeof value==='string'&&value.trim()&&!generationText(value)?clean(value):'';
    }).filter(Boolean);
    if(facts.length)return clip([...new Set(facts)].join('；'));
    // A manual introduction is plain prose; legacy prompt-only descriptions stay out.
    if(!generationText(body)){
      const introduction=prose(body.split(/^\s*#{1,6}\s/m)[0]);
      if(introduction)return clip(introduction);
    }
    return EMPTY;
  }
  const api={summary};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else global.StudioCharacterProfile=api;
})(typeof window!=='undefined'?window:globalThis);
