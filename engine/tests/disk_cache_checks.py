#!/usr/bin/env python3
"""Exercise the native cache against real source files and GPU renders.
No timing claim: check identity, source changes, corruption, eviction and trim.
"""
import argparse
import os
import tempfile
from pathlib import Path
from host_smoke import Host,write_png

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host',required=True);parser.add_argument('--resources',required=True)
    parser.add_argument('--wrapper');args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='spektralab-cache-') as temp:
        root=Path(temp);cache=root/'缓存';photo=root/'照片.png';write_png(photo,64,40)
        host=Host(([args.wrapper] if args.wrapper else [])+[args.host,'--resources',args.resources,'--cache-dir',str(cache)])
        def call(method,params=None):
            header,body=host.call(method,params);assert header.get('ok'),header
            return header['result'],body
        def stats():return call('cache_info')[0]
        def develop():
            opened,_=call('open',{'path':str(photo),'params':{'grain_active':False,'halation_active':False,'glare_active':False}})
            sid=opened['session'];_,pixels=call('render',{'session':sid,'tier':'full','format':'rgba16','display':'prophoto'})
            call('close',{'session':sid});return pixels
        try:
            hello,_=call('hello');assert hello['backend']['available'],'Requires real Vulkan, no skipped pass'
            assert stats()['available'] and stats()['entries']==0
            first=develop();assert stats()['misses']==1 and stats()['entries']==1
            assert develop()==first and stats()['hits']==1
            # Invalidate on source modification, including when size stays fixed.
            before=photo.stat();os.utime(photo,ns=(before.st_atime_ns,before.st_mtime_ns+2_000_000_000))
            assert develop()==first and stats()['misses']==2 and stats()['entries']==2
            # Corrupt payloads are rebuilt rather than handed to the engine.
            for entry in cache.glob('*.spkc'):
                payload=bytearray(entry.read_bytes());payload[-1]^=128;entry.write_bytes(payload)
            assert develop()==first and stats()['misses']==3
            # Whole-source/options keys survive persistence; header corruption
            # and truncation also become misses, never partial decode hits.
            for entry in cache.glob('*.spkc'):entry.write_bytes(b'SPKDC001')
            assert develop()==first and stats()['misses']==4
            memory,_=call('memory_trim');assert memory['pool']['free_bytes']==0
            assert develop()==first,'Releasing idle buffers changed rendered pixels'
            # The cap is a soft cache target: even a one-byte test target
            # must retain live frame holdings while reclaiming idle buffers.
            memory,_=call('memory_configure',{'reserve_bytes':0,'cap_bytes':1,'allow_over_reserve':False})
            assert memory['policy']['cap_bytes']==1 and memory['system']['total_physical_bytes']>0
            assert develop()==first,'Automatic budget enforcement evicted the active frame'
            memory,_=call('memory_report');assert memory['pool']['free_bytes']==0
            header,_=host.call('memory_configure',{'reserve_bytes':-1,'cap_bytes':0,'allow_over_reserve':False})
            assert not header['ok'] and call('memory_report')[0]['policy']['cap_bytes']==1
            call('memory_configure',{'reserve_bytes':0,'cap_bytes':0,'allow_over_reserve':True})
            call('cache_configure',{'limit_bytes':0});assert stats()['entries']==0 and stats()['bytes']==0
            assert develop()==first and stats()['entries']==0
            call('cache_configure',{'limit_bytes':1024*1024});develop();assert stats()['entries']==1
            call('cache_clear');assert stats()['entries']==0 and photo.exists()
            assert not list(cache.glob('*.partial'))
            call('shutdown');assert host.p.wait(timeout=20)==0
        finally:
            if host.p.poll() is None:host.p.kill();host.p.wait(timeout=10)
    print('PASS: native cache reuse, invalidation, corruption, eviction, clear, GPU trim and automatic memory budgets retaining active frames')

if __name__=='__main__':main()
