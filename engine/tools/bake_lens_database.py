#!/usr/bin/env python3
"""Bake unmodified Lensfun 0.3.4 measurements; no Python/XML parser at runtime.

Usage: python3 engine/tools/bake_lens_database.py <Lensfun source checkout>
The film/material resources are deliberately not touched.
"""
from pathlib import Path
import json, re, subprocess, sys, xml.etree.ElementTree as ET
root=Path(__file__).resolve().parents[2]
source=Path(sys.argv[1])
commit=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD']).decode().strip()
assert commit=='101c745e847a5de4a1e569a94368ce2027198598', 'Use the pinned Lensfun v0.3.4 source'
models={'poly3':1,'poly5':2,'ptlens':3,'linear':4,'pa':5}
terms={'distortion':{'poly3':['k1'],'poly5':['k1','k2'],'ptlens':['a','b','c']},
       'tca':{'linear':['kr','kb'],'poly3':['vr','vb','cr','cb','br','bb']},'vignetting':{'pa':['k1','k2','k3']}}
def text(node,key,default=''):
    return next((child.text.strip() for child in node.findall(key) if child.text and not child.get('lang')),default)
def number(node,key,default):
    value=text(node,key)
    if ':' in value:
        a,b=value.split(':');return float(a)/float(b)
    return float(value) if value else default
lenses=[];cameras=[]
for file in sorted((source/'data/db').glob('*.xml')):
    tree=ET.parse(file).getroot()
    for camera in tree.findall('camera'):
        cameras.append({'maker':text(camera,'maker'),'models':[c.text.strip() for c in camera.findall('model') if c.text],
                        'crop':number(camera,'cropfactor',1)})
    for lens in tree.findall('lens'):
        item={'maker':text(lens,'maker'),'model':text(lens,'model'),'crop':number(lens,'cropfactor',1),
              'aspect':number(lens,'aspect-ratio',1.5),'center':[0,0],'distortion':[],'tca':[],'vignetting':[]}
        center=lens.find('center')
        if center is not None:item['center']=[float(center.get('x','0')),float(center.get('y','0'))]
        for calibration in lens.findall('calibration'):
            for group,known in terms.items():
                for record in calibration.findall(group):
                    model=record.get('model')
                    if model not in known:raise ValueError(f'Unsupported {group} model {model}')
                    keys=known[model]
                    sample={'model':models[model],'focal':float(record.get('focal')),
                        'aperture':float(record.get('aperture','0')),'distance':float(record.get('distance','1000')),
                        'terms':[float(record.get(k,'1' if k in ['kr','kb','vr','vb'] else '0')) for k in keys]}
                    # Lensfun AddCalib* replaces the previous measurement at
                    # the same focal (and aperture/distance for vignetting).
                    identity=['focal','aperture','distance'] if group=='vignetting' else ['focal']
                    previous=next((i for i,p in enumerate(item[group]) if all(p[k]==sample[k] for k in identity)),None)
                    if previous is None:item[group].append(sample)
                    else:item[group][previous]=sample
        if not any(item[k] for k in terms):continue
        focal=[x['focal'] for group in terms for x in item[group]]
        match=re.search(r'(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*mm',item['model'],re.I)
        if any(word in item['model'] for word in ['adapter','reducer','booster','extender','converter']):match=None
        if match:focal += [float(match[1]),float(match[2] or match[1])]
        # GuessParameters includes every calibration's range even when the
        # model name supplied a focal length (including crop/FOV records).
        focal += [float(r.get('focal')) for c in lens.findall('calibration') for r in c if r.get('focal')]
        item['min_focal']=min(focal)
        item['max_focal']=max(focal)
        declared=lens.find('focal')
        if declared is not None:
            item['min_focal']=float(declared.get('min',declared.get('value',str(item['min_focal']))))
            item['max_focal']=float(declared.get('max',declared.get('value',str(item['max_focal']))))
        lenses.append(item)
out=root/'engine/resources/lens_profiles.json'
out.write_text(json.dumps({'source':'Lensfun v0.3.4','commit':commit,'license':'CC-BY-SA-3.0','cameras':cameras,'lenses':lenses},ensure_ascii=False,separators=(',',':')))
print(f'Baked {len(lenses)} measured lenses and {len(cameras)} camera crop factors to {out}')
