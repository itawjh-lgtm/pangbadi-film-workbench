#!/usr/bin/env python3
"""Refresh only RunningHub public documentation. No credentials or generation calls."""
import concurrent.futures, datetime, json, re, urllib.request, pathlib, time, subprocess, os, tempfile
from urllib.parse import urlsplit
import yaml
ROOT=pathlib.Path(__file__).resolve().parent
INDEX='https://www.runninghub.cn/runninghub-api-doc-cn/llms.txt'
def get(url):
    parsed=urlsplit(url)
    if parsed.scheme!='https' or parsed.netloc!='www.runninghub.cn' or not parsed.path.startswith('/runninghub-api-doc-cn/'):
        raise ValueError('Only official public RunningHub documentation is allowed')
    for attempt in range(3):
        try:
            return subprocess.check_output(['curl','--fail','--location','--silent','--show-error','--max-time','35',url],text=True)
        except Exception:
            if attempt==2:raise
            time.sleep(1+attempt)
def clean_schema(x,key=''):
    if isinstance(x,list): return [clean_schema(y) for y in x]
    if not isinstance(x,dict):return x
    result={}
    for k,v in x.items():
        if k.startswith('x-') or k in ['example','examples']:continue
        if k=='default' and (key in ['prompt','negativePrompt'] or re.search(r'https?://|Bearer|apiKey|Rh-Comfy-Auth',json.dumps(v))): continue
        result[k]=clean_schema(v,k)
    # URL examples, example prompts and signed references must never become product defaults.
    if key in ['prompt','negativePrompt','firstImageUrl','lastImageUrl','imageUrl','imageUrls','videoUrl','audioUrl','referenceImages','referenceImageUrls']:
        result.pop('default',None)
    # Some documented workflows use node names such as 84##value for prompts.
    # Only typed scalar or declared enum defaults are safe to seed automatically.
    if 'default' in result:
        default=result['default']
        if (isinstance(default,(dict,list)) or
            (isinstance(default,str) and default not in result.get('enum',[]))):
            result.pop('default')
    return result
def fetch_row(row):
    raw=get(row['docUrl']); match=re.search(r'```(?:yaml|yml)\s*\n(.*?)\n```',raw,re.S)
    if not match: return dict(row,proseDocument=True,operations=[])
    spec=yaml.safe_load(match.group(1)); operations=[]
    for path,verbs in spec.get('paths',{}).items():
        for verb,op in verbs.items():
            if verb not in ['post','get','put','delete','patch']:continue
            schema=op.get('requestBody',{}).get('content',{}).get('application/json',{}).get('schema',{})
            operations.append(dict(path=path,method=verb.upper(),operationId=op.get('operationId',''),label=op.get('summary',row['label']),description=op.get('description',''),deprecated=bool(op.get('deprecated')),schema=clean_schema(schema),components=clean_schema(spec.get('components',{})),responses=clean_schema(op.get('responses',{}))))
    return dict(row,operations=operations)
def build_runtime(payload):
    models=[]
    for m in payload['models']:
        parts=m['category'].split(' > ')
        models.append({k:m[k] for k in ['id','path','method','label','description','docUrl','schema','deprecated']} | dict(mediaType='image' if parts[1]=='图像生成与处理' else 'video',capability=parts[2],family=parts[3] if len(parts)>3 else m['id'].split('/')[0],available=not(m['deprecated'] or '已下架' in m['label'] or 'deprecated' in m['id'].lower())))
    return {k:payload[k] for k in ['source','retrievedAt']} | dict(modelCount=len(models),activeModelCount=sum(m['available'] for m in models),models=models)
def validate_snapshot(payload):
    if payload['errors']:
        raise ValueError(f"Public documentation fetch failed for {len(payload['errors'])} documents; previous catalog retained")
    models=payload['models']
    if not models:
        raise ValueError('Empty model catalog; previous catalog retained')
    paths=set()
    for model in models:
        path=model['path']
        if model['method']!='POST' or not path.startswith('/openapi/v2/') or path in paths:
            raise ValueError('Unsupported or duplicate model path; previous catalog retained')
        if model['schema'].get('type')!='object' or not model['schema'].get('properties'):
            raise ValueError('Missing model input schema; previous catalog retained')
        paths.add(path)

def save_snapshot(folder,payload,data,index):
    validate_snapshot(payload)
    files={
        'public-model-catalog.json':json.dumps(payload,ensure_ascii=False,indent=2)+'\n',
        'runtime-model-catalog.json':json.dumps(build_runtime(payload),ensure_ascii=False,indent=2)+'\n',
        'public-document-schemas.json':json.dumps(dict(source=INDEX,retrievedAt=payload['retrievedAt'],documents=data),ensure_ascii=False,indent=2)+'\n',
        'llms.txt':index,
    }
    # Build every output successfully before replacing any existing file.
    staged=[]
    try:
        for name,body in files.items():
            with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=folder,delete=False) as output:
                output.write(body); output.flush(); os.fsync(output.fileno())
                staged.append((pathlib.Path(output.name),folder/name))
        for temp,target in staged:os.replace(temp,target)
    finally:
        for temp,_ in staged:temp.unlink(missing_ok=True)

def main():
    index=get(INDEX); rows={}
    for line in index.splitlines():
        m=re.match(r'- (.*?)\[(.*?)\]\((https://[^)]+)\):',line)
        if not m:continue
        category,label,url=m.groups();category=category.strip()
        if ('模型API' in category and ('图像生成与处理' in category or '视频生成与处理' in category)) or category in ['任务和查询 & webhook','账户相关'] or label in ['开始','模型 API  错误码说明']:
            if url not in rows: rows[url]=dict(label=label,category=category,categories=[category],docUrl=url)
            elif category not in rows[url]['categories']:rows[url]['categories'].append(category)
    print('Unique public docs:',len(rows),flush=True)
    data=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures={pool.submit(fetch_row,row):row for row in rows.values()}
        for n,future in enumerate(concurrent.futures.as_completed(futures),1):
            try:data.append(future.result())
            except Exception as exc:data.append(dict(futures[future],error=str(exc)))
            if n%25==0:print('Fetched',n,flush=True)
    data.sort(key=lambda x:(x['category'],x['label'],x['docUrl']))
    model_ops=[]
    for doc in data:
        if '模型API' not in doc['category']:continue
        for op in doc.get('operations',[]):
            model_ops.append(dict(id=op['path'].removeprefix('/openapi/v2/'),docUrl=doc['docUrl'],category=doc['category'],categories=doc['categories'],**op))
    timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
    payload=dict(source=INDEX,retrievedAt=timestamp,documentCount=len(data),models=model_ops,errors=[dict(docUrl=d['docUrl'],error=d['error']) for d in data if d.get('error')])
    save_snapshot(ROOT,payload,data,index)
    print(json.dumps(dict(documents=len(data),operations=len(model_ops),errors=len(payload['errors'])),ensure_ascii=False),flush=True)
if __name__=='__main__':main()
