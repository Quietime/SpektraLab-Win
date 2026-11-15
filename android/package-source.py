#!/usr/bin/env python3
"""Package the build 13304 Android corresponding source without signing secrets."""
from pathlib import Path
import hashlib,json,subprocess,zipfile
ROOT=Path(__file__).resolve().parents[1];ART=ROOT/'artifacts';ART.mkdir(exist_ok=True)
DEPENDENCIES=Path('/workspace/recovery/installer/source')
OUT=ART/'SpektraLab-Android-1.3.3-LightTable.3-source.zip'
FORBIDDEN={'update-signing-private.pem','android-signing.pass','android-signing.jks','signing-backup.pass','private-signing-backup.zip'}
DENIED_SUFFIXES={'.jks','.pass','.enc','.p12','.pfx','.key','.pem','.der'}
def sha(data):return hashlib.sha256(data).hexdigest()
names=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
index={}
with zipfile.ZipFile(OUT,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
 for name in sorted(set(filter(None,names))):
  path=ROOT/name
  if not path.is_file():continue
  if name.startswith(('build/','artifacts/','.git/','desktop/node_modules/')) or path.name in FORBIDDEN or path.suffix.lower() in DENIED_SUFFIXES:
   raise RuntimeError('Refusing secret or cache path in source archive: '+name)
  data=path.read_bytes();archive.writestr('SpektraLab/'+name,data);index[name]=sha(data)
 archive.writestr('SOURCE-INDEX.json',json.dumps(index,sort_keys=True,indent=2))
 for name in ('Frontend-runtime-dependency-sources.zip','LibRaw-0.22.2.zip','LICENSE-PROVENANCE.json','LICENSE-REVIEW-GAPS.json','THIRD-PARTY-COMPONENTS.json','README-SOURCE.txt'):
  path=DEPENDENCIES/name
  if not path.is_file():raise FileNotFoundError(path)
  archive.write(path,'dependencies/'+name,compress_type=zipfile.ZIP_STORED if path.suffix=='.zip' else zipfile.ZIP_DEFLATED)
 licenses=DEPENDENCIES/'licenses'
 if not licenses.is_dir():raise FileNotFoundError(licenses)
 for path in sorted(licenses.rglob('*')):
  if path.is_file():archive.write(path,'dependencies/licenses/'+path.relative_to(licenses).as_posix())
 for name in ('NOTICE','NOTICE.toolchain'):
  archive.write(ROOT/'build/android-sdk/ndk/27.2.12479018'/name,'dependencies/Android-NDK-'+name)
 archive.writestr('README-ANDROID.txt','Corresponding source for SpektraLab LightTable Android build 13304 (1.3.3-lighttable.3), package app.spektralab.lighttable, both phone and tablet flavors. Build instructions: SpektraLab/android/README.zh-CN.md. Android SDK/NDK toolchains and private signing keys are not included.\n')
with zipfile.ZipFile(OUT) as archive:
 assert archive.testzip() is None
 for name,digest in index.items():assert sha(archive.read('SpektraLab/'+name))==digest,name
receipt={'source_archive':OUT.name,'bytes':OUT.stat().st_size,'sha256':sha(OUT.read_bytes()),'source_files_verified':len(index),'build':13304,'version':'1.3.3-lighttable.3','package':'app.spektralab.lighttable'}
(ART/'ANDROID133-SOURCE-RECEIPT.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
