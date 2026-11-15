#!/usr/bin/env python3
"""Extract the Mac agent's field contract; Python is only a developer tool."""
import json,re
from pathlib import Path
root=Path(__file__).resolve().parents[2]
source=(root/'modern_UI/Spektrafilm/Spektrafilm/Agent/AgentSchema.swift').read_text()
ranges={'ContrastMaskSettings.scaleRange':[.002,.12],'EffectStrengths.grainRange':[0,2],
 'EffectStrengths.halationRange':[0,4],'EffectStrengths.highlightBoostRange':[0,8],
 'EffectStrengths.scatterRange':[0,1],'EffectStrengths.couplersRange':[0,1.5],
 'EffectStrengths.glareRange':[0,30],'FilmEdgeSettings.seedRange':[0,2147483647],
 'FilmEdgeSettings.frameNumberRange':[0,99],'FilmEdgeSettings.fogRange':[0,4],
 'FilmEdgeSettings.leaksRange':[0,4],'DateBackSettings.insetRange':[0,30],
 'DateBackSettings.sizeRange':[.4,3],'DateBackSettings.brightnessRange':[-2,8],
 '-Geometry.maxAngle...Geometry.maxAngle':[-45,45]}
def arguments(start):
    depth=0;quoted=False;escaped=False;parts=[];at=start
    for i in range(start,len(source)):
        c=source[i]
        if quoted:
            if escaped:escaped=False
            elif c=='\\':escaped=True
            elif c=='"':quoted=False
        elif c=='"':quoted=True
        elif c in '([':depth+=1
        elif c in ')]':
            if depth==0:parts.append(source[at:i].strip());return parts
            depth-=1
        elif c==',' and depth==0:parts.append(source[at:i].strip());at=i+1
    raise ValueError('unterminated AgentField')
fields=[]
for match in re.finditer(r'\.init\("(?:params|adjustments|geometry|decode)\.',source):
    parts=arguments(match.start()+6)
    if '\\(' in parts[0]:continue
    path=json.loads(parts[0]);kind=parts[1];row={'path':path,'doc':json.loads(parts[2])}
    if kind in ['.film','.paper','.bool','.points','.size']:row['type']=kind[1:]
    elif kind.startswith(('.number(','.integer(')):
        name,expression=kind[1:].split('(',1);expression=expression[:-1]
        values=ranges.get(expression)
        if values is None:values=[float(v) for v in expression.split('...')]
        row.update(type=name,min=values[0],max=values[1])
    elif kind.startswith('.choice('):
        expression=kind[8:-1];row['type']='choice'
        if expression.startswith('[') and '.map' not in expression:row['enum']=json.loads(expression)
        else:row['choiceSource']=expression
    else:raise ValueError(kind)
    if len(parts)>3:
        reason=parts[3].split('readOnly:',1)[1].strip()
        row['readOnly']=json.loads(reason) if reason.startswith('"') else 'Resolved by the app; use the corresponding UI control.'
    if path.startswith('params.contrastMask.'):row['readOnly']='The Tone Mask is withdrawn in this version and does not render.'
    fields.append(row)
for prefix in ['sceneLatitude','sceneLatitudeOther']:
    for name in ['highlightPullBack','shadowPullBack','shadowPercentile','highlightPercentile','active','norm','highlightKnee','highlightRoom','shadowKnee','shadowRoom','rolloff','maxLift']:
        fields.append({'path':f'params.{prefix}.{name}','type':'number','min':-20,'max':20,
                       'doc':'Solved scene placement.','readOnly':'Use place_scene to solve a placement through the Fit.'})
for channel in ['rgb','luma','red','green','blue']:
    fields.append({'path':f'adjustments.curves.{channel}.points','type':'points','doc':f'{channel} curve: strictly ascending x from 0 to 1.'})
for zone in ['master','shadows','midtones','highlights']:
    for name,lo,hi in [('hue',0,360),('saturation',0,1),('luminance',-1,1)]:
        fields.append({'path':f'adjustments.colorBalance.{zone}.{name}','type':'number','min':lo,'max':hi,'doc':f'{zone} {name}.'})
assert len({f['path'] for f in fields})==len(fields)
output=root/'desktop/src/agent/fields.json';output.parent.mkdir(exist_ok=True)
output.write_text(json.dumps(fields,ensure_ascii=False,indent=2)+'\n')
print(f'Extracted {len(fields)} Mac agent fields into {output}')

# One catalog is consumed by the frontend dispatcher and the Rust MCP/CLI.
tools=[]
base={'path':{'type':'string','description':'Absolute photograph path.'}}
extra={
 'edit_image':{'patch':{'type':'object'}},
 'place_scene':{'highlight':{'type':'number','minimum':0,'maximum':6},'shadow':{'type':'number','minimum':0,'maximum':6}},
 'preview_image':{'long_edge':{'type':'integer','minimum':64,'maximum':4096},'output':{'type':'string'}},
 'export_image':{'recipe':{'type':'string'},'folder':{'type':'string'}},
}
text=(root/'modern_UI/Spektrafilm/Spektrafilm/Agent/AgentTools.swift').read_text()
for m in re.finditer(r'\.init\(name: "([^"\n]+)", command: "([^"\n]+)",\s+summary: ("(?:\\.|[^"\\])*")',text):
 name,command,description=m.groups();props={} if name in ['get_schema','list_stocks','list_recipes'] else dict(base)
 props.update(extra.get(name,{}));required=list(props) if name=='place_scene' else ['path','patch'] if name=='edit_image' else ['path'] if props else []
 if name in ['edit_image','reset_edit','process_image','place_scene']:props['preview']={'type':'boolean','default':True}
 tools.append({'name':name,'command':command,'description':json.loads(description),'inputSchema':{'type':'object','properties':props,'required':required,'additionalProperties':False}})
assert len(tools)==12
(root/'desktop/src/agent/tools.json').write_text(json.dumps(tools,ensure_ascii=False,indent=2)+'\n')
print('Extracted 12 Mac agent tools')
