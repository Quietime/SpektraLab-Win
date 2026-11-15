#!/usr/bin/env python3
"""Actual LibRaw boundary checks with an explicitly synthetic Bayer DNG.
No photograph, camera brand's sensor values or private Apple calibration is
claimed. The constant patch has a declared identity XYZ-to-camera matrix.
"""
import argparse,hashlib,struct,tempfile
from pathlib import Path
from host_smoke import Host

def ifd(records,start):
    entries=[];extra=bytearray();base=start+2+12*len(records)+4
    for tag,kind,value in sorted(records):
        if kind==2:body=value.encode()+b'\0';count=len(body)
        elif kind==1:body=bytes(value);count=len(body)
        elif kind in (3,4):count=len(value);body=struct.pack('<'+('H' if kind==3 else 'I')*count,*value)
        elif kind in (5,10):
            count=len(value);body=b''.join(struct.pack('<II' if kind==5 else '<ii',*pair) for pair in value)
        else:raise ValueError(kind)
        if len(body)<=4:slot=body.ljust(4,b'\0')
        else:
            slot=struct.pack('<I',base+len(extra));extra.extend(body)
            if len(extra)%2:extra.append(0)
        entries.append(struct.pack('<HHI',tag,kind,count)+slot)
    return struct.pack('<H',len(records))+b''.join(entries)+b'\0'*4+extra

def dng(path,black=False):
    w,h=96,64
    records=[(256,4,[w]),(257,4,[h]),(258,3,[16]),(259,3,[1]),(262,3,[32803]),
        (271,2,'Canon'),(272,2,'Synthetic XYZ camera'),(273,4,[0]),(274,3,[1]),(277,3,[1]),
        (278,4,[h]),(279,4,[w*h*2]),(33421,3,[2,2]),(33422,1,[0,1,1,2]),(34665,4,[0]),
        (50706,1,[1,4,0,0]),(50707,1,[1,1,0,0]),(50708,2,'SpektraLab synthetic XYZ DNG'),
        (50710,1,[0,1,2]),(50711,3,[1]),(50714,5,[(0,1)]),(50717,4,[65535]),
        (50721,10,[(1 if i%4==0 else 0,1) for i in range(9)]),
        (50728,5,[(95047,100000),(1,1),(108883,100000)]),(50778,3,[21])]
    exif=[(33437,5,[(18,10)]),(37386,5,[(50,1)]),(41989,3,[50]),(42036,2,'Canon EF 50mm f/1.8 STM')]
    start=8+len(ifd(records,8));exif_bytes=ifd(exif,start);pixels=start+len(exif_bytes)
    records=[(tag,kind,[pixels] if tag==273 else [start] if tag==34665 else value) for tag,kind,value in records]
    # D65 XYZ, Y=.3. The Bayer mosaic's channels are camera coordinates.
    channel=[0,0,0] if black else [19009,20000,21777]
    raw=b''.join(struct.pack('<H',channel[[0,1,1,2][(y%2)*2+x%2]]) for y in range(h) for x in range(w))
    Path(path).write_bytes(b'II*\0'+struct.pack('<I',8)+ifd(records,8)+exif_bytes+raw)

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--host',required=True);parser.add_argument('--resources',required=True);parser.add_argument('--wrapper');args=parser.parse_args()
    host=Host(([args.wrapper] if args.wrapper else [])+[args.host,'--resources',args.resources])
    def call(method,params):
        header,body=host.call(method,params);assert header.get('ok'),header;return header['result'],body
    try:
        with tempfile.TemporaryDirectory(prefix='spektralab-camera-') as temp:
            path=Path(temp)/'中性样本.dng';dng(path);digest=hashlib.sha256(path.read_bytes()).digest()
            probe,_=call('probe',{'path':str(path)});assert probe['kind']=='raw',probe
            assert probe['metadata'].get('lens_profile')=='Canon EF 50mm f/1.8 STM',probe
            picked,_=call('neutral_point',{'path':str(path),'x':.5,'y':.5})
            assert 6300<picked['temperature_k']<6800 and abs(picked['tint'])<30,picked
            corrected,_=call('neutral_point',{'path':str(path),'x':.5,'y':.5,'lens_correction':True})
            assert abs(corrected['temperature_k']-picked['temperature_k'])<5,corrected
            opened,_=call('open',{'path':str(path),'decode':{'white_balance':{'mode':'custom',**picked}},'params':{'grain_active':False,'halation_active':False,'glare_active':False}})
            sid=opened['session'];_,before=call('render',{'session':sid,'tier':'full','display':'prophoto','format':'rgba16'})
            call('redecode',{'session':sid,'decode':{'lens_correction':True,'white_balance':{'mode':'custom',**picked}}})
            _,after=call('render',{'session':sid,'tier':'full','display':'prophoto','format':'rgba16'})
            assert before!=after,'Measured lens correction changed no output pixels'
            call('close',{'session':sid})
            for x,y in [(-.1,.5),(.5,1.1)]:
                header,_=host.call('neutral_point',{'path':str(path),'x':x,'y':y});assert not header['ok']
            black=Path(temp)/'black.dng';dng(black,True)
            header,_=host.call('neutral_point',{'path':str(black),'x':.5,'y':.5});assert not header['ok'],'A black patch cannot define neutral chromaticity'
            assert hashlib.sha256(path.read_bytes()).digest()==digest,'An input RAW was modified'
        call('shutdown',{});assert host.p.wait(timeout=20)==0
    finally:
        if host.p.poll() is None:host.p.kill();host.p.wait(timeout=10)
    print('PASS: synthetic DNG camera neutral, measured lens matching/redecode, corrected-coordinate picker and refusals')

if __name__=='__main__':main()
