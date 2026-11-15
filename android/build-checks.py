#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import shutil,zipfile,sys,secrets,os
spec=importlib.util.spec_from_file_location('apk',Path(__file__).with_name('build-apk.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
r=m.ROOT;b=m.BUILD;t=m.TOOLS;sdk=m.SDK;o=b/'android-checks';shutil.rmtree(o,ignore_errors=True);o.mkdir()
if os.environ.get('SPEKTRALAB_HOST_JAVA')=='1':
 classes=b/'android-check-classes';shutil.rmtree(classes,ignore_errors=True);classes.mkdir()
 m.run(['java','--module','jdk.compiler/com.sun.tools.javac.Main','-encoding','UTF-8','-source','11','-target','11','-classpath',sdk/'platforms/android-35/android.jar','-d',classes,*sorted((r/'android/tests/app/spektralab/checks').glob('*.java'))])
 m.run(['java','--module','jdk.jartool/sun.tools.jar.Main','cf',b/'android-checks.jar','-C',classes,'.'])
else:m.docker(['bash','-c','rm -rf build/android-check-classes; mkdir -p build/android-check-classes; javac -encoding UTF-8 --release 11 -classpath build/android-sdk/platforms/android-35/android.jar -d build/android-check-classes android/tests/app/spektralab/checks/*.java && jar cf build/android-checks.jar -C build/android-check-classes .'])
dex=o/'dex';dex.mkdir();m.run([t/'d8','--min-api','29','--lib',sdk/'platforms/android-35/android.jar','--output',dex,b/'android-checks.jar'])
assets=o/'assets';assets.mkdir();sys.path.insert(0,str(r/'engine/tests'));from camera_picker_checks import dng;dng(assets/'fixture.dng')
fixtures=r/'distribution/updater/tests'
if fixtures.is_dir():shutil.copytree(fixtures,assets/'updater',ignore=shutil.ignore_patterns('README.md'))
else:(assets/'updater').mkdir()
shutil.copy2(r/'distribution/updater/public-key.json',assets/'updater/public-key.json')
# Small package archives exercise Android's package/version/channel/certificate
# checks. They are test APK assets only, never included in the product APK.
fixture_key=o/'fixture-signing.jks';fixture_pass=o/'fixture-signing.pass';fixture_pass.write_text(secrets.token_hex(20)+'\n');fixture_pass.chmod(0o600)
m.run(['keytool','-genkeypair','-keystore',fixture_key,'-storepass:file',fixture_pass,'-keypass:file',fixture_pass,'-alias','fixture','-keyalg','RSA','-keysize','2048','-validity','10000','-dname','CN=SpektraLab Test Fixture'])
for flavor in ('phone','tablet'):
 channel='android-'+flavor+'-arm64';opposite='android-'+('tablet' if flavor=='phone' else 'phone')+'-arm64'
 for kind,package,version,embedded_channel,alternate_key in [
  ('valid','app.spektralab.lighttable',13305,channel,False),
  ('wrong-package','app.spektralab.fixture',13305,channel,False),
  ('wrong-version','app.spektralab.lighttable',13306,channel,False),
  ('wrong-channel','app.spektralab.lighttable',13305,opposite,False),
  ('wrong-signer','app.spektralab.lighttable',13305,channel,True),
 ]:
  stem=flavor+'-'+kind;manifest=o/(stem+'-manifest.xml')
  manifest.write_text(f'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{package}" android:versionCode="{version}"><uses-sdk android:minSdkVersion="29" android:targetSdkVersion="35"/><application><meta-data android:name="app.spektralab.update_channel" android:value="{embedded_channel}"/></application></manifest>')
  unsigned=o/(stem+'-unsigned.apk');m.run([t/'aapt2','link','-o',unsigned,'--manifest',manifest,'-I',sdk/'platforms/android-35/android.jar','--min-sdk-version','29','--target-sdk-version','35'])
  key=fixture_key if alternate_key else b/'android-signing.jks';password=fixture_pass if alternate_key else b/'android-signing.pass';alias='fixture' if alternate_key else 'spektralab'
  m.run([t/'apksigner','sign','--v4-signing-enabled','false','--ks',key,'--ks-key-alias',alias,'--ks-pass','file:'+str(password),'--out',assets/'updater'/('archive-'+stem+'.apk'),unsigned])
upgrade={name:os.environ.get('SPEKTRALAB_ANDROID_UPGRADE_'+name.upper()) for name in ('apk','manifest','signature','flavor')}
if any(upgrade.values()):
 if not all(upgrade.values()) or upgrade['flavor'] not in ('phone','tablet'):raise ValueError('Set UPGRADE_APK, UPGRADE_MANIFEST, UPGRADE_SIGNATURE, UPGRADE_FLAVOR together')
 target=assets/'upgrade';target.mkdir()
 for source,name in [('apk','package.apk'),('manifest','updates.json'),('signature','updates.json.sig')]:shutil.copy2(upgrade[source],target/name)
 (target/'flavor.txt').write_text(upgrade['flavor']+'\n')
u=o/'unsigned.apk';m.run([t/'aapt2','link','-o',u,'--manifest',r/'android/tests/AndroidManifest.xml','-I',sdk/'platforms/android-35/android.jar','-A',assets])
with zipfile.ZipFile(u,'a',zipfile.ZIP_DEFLATED) as z:z.write(dex/'classes.dex','classes.dex')
a=o/'aligned.apk';m.run([t/'zipalign','-f','4',u,a]);m.run([t/'apksigner','sign','--ks',b/'android-signing.jks','--ks-key-alias','spektralab','--ks-pass','file:'+str(b/'android-signing.pass'),'--out',o/'checks.apk',a])
print(o/'checks.apk')
