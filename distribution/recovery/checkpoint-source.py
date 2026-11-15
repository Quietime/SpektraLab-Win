#!/usr/bin/env python3
"""Create a verified source-only WIP checkpoint; never archive signing secrets."""
from pathlib import Path
import argparse,datetime,hashlib,json,subprocess,zipfile
r=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--out',type=Path,default=r/'build/Source-Checkpoint-13304.zip');p.add_argument('--status',default='Work in progress; not a release');args=p.parse_args()
names=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=r).decode().split('\0');index={};out=args.out.resolve();out.parent.mkdir(parents=True,exist_ok=True)
forbidden={'update-signing-private.pem','android-signing.pass','android-signing.jks','signing-backup.pass','private-signing-backup.zip'}
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
 for name in sorted(set(filter(None,names))):
  path=r/name
  if not path.is_file():continue
  if name.startswith(('build/','artifacts/','.git/','desktop/node_modules/')) or path.name in forbidden or path.suffix in ('.jks','.pass','.enc'):raise RuntimeError('Refusing secret/cache path in source checkpoint')
  raw=path.read_bytes();archive.writestr('SpektraLab/'+name,raw);index[name]=hashlib.sha256(raw).hexdigest()
 archive.writestr('SOURCE-INDEX.json',json.dumps(index,sort_keys=True,indent=2))
 archive.writestr('CHECKPOINT-STATUS.json',json.dumps({'build':13304,'version':'1.3.3-lighttable.3','utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':args.status,'release_ready':False,'files':len(index)},indent=2))
with zipfile.ZipFile(out) as archive:
 assert archive.testzip() is None
 for name,digest in index.items():assert hashlib.sha256(archive.read('SpektraLab/'+name)).hexdigest()==digest,name
print(json.dumps({'file':str(out),'bytes':out.stat().st_size,'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'source_files':len(index)}))
