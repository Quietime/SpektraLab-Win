#!/usr/bin/env python3
"""Derive a full build13303 predecessor from a tested build13304 APK.

The product manifest and all code/native/assets are retained, with only
versionCode/versionName changed. Output stays under build/ for OS upgrade tests.
"""
import argparse,importlib.util,re,shutil,zipfile,xml.etree.ElementTree as ET
from pathlib import Path
spec=importlib.util.spec_from_file_location('apk',Path(__file__).with_name('build-apk.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
parser=argparse.ArgumentParser();parser.add_argument('--final',required=True,type=Path);parser.add_argument('--flavor',required=True,choices=('phone','tablet'));args=parser.parse_args()
final=args.final.resolve();assert final.is_file(),final
root=m.ROOT;build=m.BUILD;tools=m.TOOLS;sdk=m.SDK;out=build/'android-upgrade'/args.flavor;shutil.rmtree(out,ignore_errors=True);out.mkdir(parents=True)
m.run([tools/'apksigner','verify','--verbose',final])
badging=m.subprocess.check_output([str(tools/'aapt2'),'dump','badging',str(final)],text=True)
if not re.search(r"package: name='app\.spektralab\.lighttable' versionCode='13304'",badging):raise ValueError('Expected final new-package build13304 APK')
xmltree=m.subprocess.check_output([str(tools/'aapt2'),'dump','xmltree','--file','AndroidManifest.xml',str(final)],text=True)
if 'android-'+args.flavor+'-arm64' not in xmltree:raise ValueError('Final APK channel differs from requested flavor')
assets=out/'assets';assets.mkdir();payload={}
with zipfile.ZipFile(final) as archive:
 for item in archive.infolist():
  name=item.filename
  if name.startswith('assets/') and not item.is_dir():
   relative=Path(name).relative_to('assets')
   if '..' in relative.parts:raise ValueError('Unsafe asset path')
   destination=assets/relative;destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(archive.read(item))
  elif re.fullmatch(r'classes(?:[2-9][0-9]*)?\.dex',name) or (name.startswith('lib/') and name.endswith('.so')):payload[name]=archive.read(item)
if 'classes.dex' not in payload or not any(name.startswith('lib/arm64-v8a/') for name in payload):raise ValueError('Final APK lacks DEX or ARM64 library')
ET.register_namespace('android','http://schemas.android.com/apk/res/android');manifest=ET.parse(root/'android/AndroidManifest.xml');ns='{http://schemas.android.com/apk/res/android}';manifest.getroot().set(ns+'versionCode','13303');manifest.getroot().set(ns+'versionName','1.3.3-lighttable.2')
metadata=manifest.getroot().find("application/meta-data[@"+ns+"name='app.spektralab.update_channel']")
if metadata is None:raise ValueError('Full manifest lacks update channel')
metadata.set(ns+'value','android-'+args.flavor+'-arm64');flavored=out/'AndroidManifest.xml';manifest.write(flavored,encoding='unicode',xml_declaration=True)
resource=out/'res/drawable';resource.mkdir(parents=True);shutil.copy2(root/'desktop/src-tauri/icons/128x128.png',resource/'icon.png');compiled=out/'resources.zip';m.run([tools/'aapt2','compile','--dir',out/'res','-o',compiled])
unsigned=out/'unsigned.apk';m.run([tools/'aapt2','link','-o',unsigned,'--manifest',flavored,'-I',sdk/'platforms/android-35/android.jar','-A',assets,'--min-sdk-version','29','--target-sdk-version','35','--version-code','13303','--replace-version',compiled])
with zipfile.ZipFile(unsigned,'a',zipfile.ZIP_DEFLATED) as apk:
 for name,data in payload.items():apk.writestr(name,data)
aligned=out/'aligned.apk';m.run([tools/'zipalign','-P','16','-f','4',unsigned,aligned]);output=out/'previous-13303.apk';m.run([tools/'apksigner','sign','--v4-signing-enabled','false','--ks',build/'android-signing.jks','--ks-key-alias','spektralab','--ks-pass','file:'+str(build/'android-signing.pass'),'--out',output,aligned]);m.run([tools/'apksigner','verify','--verbose',output])
def signer(apk):
 report=m.subprocess.check_output([str(tools/'apksigner'),'verify','--print-certs',str(apk)],text=True);match=re.search(r'Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]+)',report)
 if not match:raise ValueError('Cannot inspect certificate')
 return match.group(1).lower()
if signer(final)!=signer(output):raise ValueError('Predecessor signer differs from final APK')
with zipfile.ZipFile(output) as previous,zipfile.ZipFile(final) as current:
 for name in payload:
  if previous.read(name)!=current.read(name):raise ValueError('Code or native library changed: '+name)
 for name in current.namelist():
  if name.startswith('assets/') and not name.endswith('/') and previous.read(name)!=current.read(name):raise ValueError('Asset changed: '+name)
print(output)
