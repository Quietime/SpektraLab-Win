#!/usr/bin/env python3
"""Build a signed, sideloadable APK without a network-dependent Gradle build."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,zipfile,xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[1];BUILD=ROOT/'build';SDK=Path(os.environ.get('ANDROID_HOME',BUILD/'android-sdk'));TOOLS=SDK/'build-tools/35.0.0'
ART=Path(os.environ.get('SPEKTRALAB_ANDROID_OUTPUT',ROOT/'artifacts'))
ABIS=os.environ.get('SPEKTRALAB_ANDROID_ABIS','arm64-v8a,x86_64').split(',')
def run(args,**kw):subprocess.run(list(map(str,args)),check=True,**kw)
def docker(args):run(['docker','exec','-w','/work','spektralab-build']+args)
def main():
 flavor=os.environ.get('SPEKTRALAB_ANDROID_FLAVOR','phone')
 if flavor not in ('phone','tablet'):raise ValueError('SPEKTRALAB_ANDROID_FLAVOR must be phone or tablet')
 channel='android-'+flavor+'-arm64'
 out=BUILD/'android-apk';shutil.rmtree(out,ignore_errors=True);out.mkdir()
 if os.environ.get('SPEKTRALAB_HOST_JAVA')=='1':
  classes=BUILD/'android-java';shutil.rmtree(classes,ignore_errors=True);classes.mkdir()
  run(['java','--module','jdk.compiler/com.sun.tools.javac.Main','-encoding','UTF-8','-source','11','-target','11','-classpath',SDK/'platforms/android-35/android.jar','-d',classes,*sorted((ROOT/'android/src/app/spektralab/android').glob('*.java'))])
  run(['java','--module','jdk.jartool/sun.tools.jar.Main','cf',BUILD/'android-classes.jar','-C',classes,'.'])
 else:docker(['bash','-c','rm -rf build/android-java; mkdir -p build/android-java; javac -encoding UTF-8 --release 11 -classpath build/android-sdk/platforms/android-35/android.jar -d build/android-java android/src/app/spektralab/android/*.java && jar cf build/android-classes.jar -C build/android-java .'])
 run(['npm','run','build:web','--','--base','./','--target','chrome74'],cwd=ROOT/'desktop')
 assets=out/'assets';shutil.copytree(ROOT/'desktop/dist',assets/'web')
 shutil.copy2(ROOT/'distribution/updater/public-key.json',assets/'update-public-key.json')
 # stage-host keeps the engine's original DI LUTs, ICC and notices together.
 # Host Java mode also stages locally, so final APK packaging can run after the
 # native build container has been removed to free disk for the emulator.
 if os.environ.get('SPEKTRALAB_HOST_JAVA')=='1' or os.environ.get('SPEKTRALAB_HOST_STAGE')=='1':
  staged=out/'android-staged';run(['bash',ROOT/'engine/stage-host.sh',BUILD/f'android-{ABIS[0]}',staged,'spektralab-host'])
 else:
  staged=BUILD/'android-staged';docker(['engine/stage-host.sh','/work/build/android-'+ABIS[0],'/work/build/android-staged','spektralab-host']);docker(['chmod','-R','a+rX','/work/build/android-staged'])
 shutil.copytree(staged/'engine',assets/'engine')
 shutil.copytree(BUILD/'host-win-x64/licenses',assets/'licenses')
 shutil.copy2(ROOT/'license/LICENSE',assets/'LICENSE')
 for notice in ['NOTICE','NOTICE.toolchain']:shutil.copy2(SDK/'ndk/27.2.12479018'/notice,assets/'licenses'/('Android-NDK-'+notice))
 dex=out/'dex';dex.mkdir();run([TOOLS/'d8','--min-api','29','--lib',SDK/'platforms/android-35/android.jar','--output',dex,BUILD/'android-classes.jar'])
 res=out/'res/drawable';res.mkdir(parents=True);shutil.copy2(ROOT/'desktop/src-tauri/icons/128x128.png',res/'icon.png')
 compiled=out/'resources.zip';run([TOOLS/'aapt2','compile','--dir',out/'res','-o',compiled])
 ET.register_namespace('android','http://schemas.android.com/apk/res/android')
 manifest=ET.parse(ROOT/'android/AndroidManifest.xml');ns='{http://schemas.android.com/apk/res/android}'
 build=int(manifest.getroot().attrib[ns+'versionCode'])
 version=manifest.getroot().attrib[ns+'versionName']
 metadata=manifest.getroot().find("application/meta-data[@"+ns+"name='app.spektralab.update_channel']")
 if metadata is None:raise ValueError('Missing immutable update channel')
 metadata.set(ns+'value',channel)
 flavored_manifest=out/'AndroidManifest.xml';manifest.write(flavored_manifest,encoding='unicode',xml_declaration=True)
 unsigned=out/'unsigned.apk';run([TOOLS/'aapt2','link','-o',unsigned,'--manifest',flavored_manifest,'-I',SDK/'platforms/android-35/android.jar','-A',assets,'--min-sdk-version','29','--target-sdk-version','35',compiled])
 with zipfile.ZipFile(unsigned,'a',zipfile.ZIP_DEFLATED) as apk:
  apk.write(dex/'classes.dex','classes.dex')
  for abi in ABIS:
   binary=BUILD/f'android-{abi}/engine/host/spektralab-host';assert binary.read_bytes()[:4]==b'\x7fELF'
   apk.write(binary,f'lib/{abi}/libspektralab_host.so')
 aligned=out/'aligned.apk';run([TOOLS/'zipalign','-P','16','-f','4',unsigned,aligned])
 key=BUILD/'android-signing.jks';password=BUILD/'android-signing.pass'
 if not key.is_file() or not password.is_file():raise FileNotFoundError('Android signing identity is missing; refusing to create a different key')
 output=ART/f'SpektraLab-Android-{flavor.title()}-1.3.3-LightTable.apk';output.parent.mkdir(parents=True,exist_ok=True)
 run([TOOLS/'apksigner','sign','--ks',key,'--ks-key-alias','spektralab','--ks-pass','file:'+str(password),'--out',output,aligned])
 run([TOOLS/'apksigner','verify','--verbose',output]);run([TOOLS/'zipalign','-P','16','-c','4',output])
 alias=ART/f'SpektraLab-Android-{flavor.title()}.apk';shutil.copy2(output,alias)
 receipt={'apk':output.name,'stable_alias':alias.name,'build':build,'version':version,'package':'app.spektralab.lighttable','channel':channel,'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'abis':ABIS,'min_android':10,'physical_device_tested':False,'emulator_tested':False}
 (ART/f'ANDROID133-{flavor.upper()}-BUILD-RECEIPT.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
if __name__=='__main__':main()
