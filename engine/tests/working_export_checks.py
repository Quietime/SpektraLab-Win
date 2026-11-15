#!/usr/bin/env python3
"""Check the real host's post-grade output conversion; synthetic input, no RAW.

The reference is the existing native render output transform, not a mock or
another copy of colour maths. This is a Windows-host regression gate, not
evidence of Metal/Vulkan parity. Requires a working Vulkan device.
"""
import argparse
import os
import struct
import tempfile
import zlib
from pathlib import Path

from host_smoke import Host, tiff_info, write_png


def rgb16(path):
    tags = tiff_info(path)
    data = Path(path).read_bytes()
    assert tags[258][1] == 3
    assert struct.unpack_from('<HHH', data, tags[258][2]) == (16, 16, 16)
    start, length = tags[273][2], tags[279][2]
    return struct.unpack('<' + 'H' * (length // 2), data[start:start + length])


def png16(path):
    """Independent standard-library PNG reader; verifies CRCs, ICC and samples."""
    data=Path(path).read_bytes()
    assert data[:8]==b'\x89PNG\r\n\x1a\n'
    at=8;compressed=bytearray();profile=None
    while at<len(data):
        length=struct.unpack_from('>I',data,at)[0]
        kind=data[at+4:at+8];body=data[at+8:at+8+length]
        assert zlib.crc32(kind+body)==struct.unpack_from('>I',data,at+8+length)[0]
        if kind==b'IHDR':
            width,height,depth,colour,compression,filtering,interlace=struct.unpack('>IIBBBBB',body)
            assert (depth,colour,compression,filtering,interlace)==(16,2,0,0,0)
        if kind==b'iCCP':
            separator=body.index(0);assert body[separator+1]==0
            profile=zlib.decompress(body[separator+2:]);assert profile[36:40]==b'acsp'
        if kind==b'IDAT':compressed.extend(body)
        at+=12+length
    assert profile is not None
    raw=zlib.decompress(compressed);stride=width*6;values=[]
    assert len(raw)==(stride+1)*height
    for y in range(height):
        method=raw[y*(stride+1)];row=bytearray(raw[y*(stride+1)+1:(y+1)*(stride+1)])
        assert method in (0,1)
        if method==1:
            for i in range(6,len(row)):row[i]=(row[i]+row[i-6])&255
        values.extend(struct.unpack('>'+'H'*(width*3),row))
    return tuple(values)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--resources', required=True)
    parser.add_argument('--wrapper', help='e.g. wine; this is not native Windows acceptance')
    args = parser.parse_args()
    host = Host(([args.wrapper] if args.wrapper else []) + [args.host, '--resources', args.resources])
    checks = 0

    def call(method, params=None, payload=b''):
        head, body = host.call(method, params, payload)
        assert head.get('ok'), head
        return head['result'], body

    try:
        hello, _ = call('hello')
        assert hello['backend']['available'], 'A Vulkan device is required; this is not a skipped pass.'
        assert 'write_working_image' in hello['methods']
        checks += 1
        with tempfile.TemporaryDirectory(prefix='spektralab-working-') as tmp:
            source = os.path.join(tmp, 'ramp.png')
            write_png(source, 64, 40)
            opened, _ = call('open', {'path': source, 'params': {
                'grain_active': False, 'glare_active': False, 'halation_active': False,
            }})
            sid = opened['session']
            working, pixels = call('render', {'session': sid, 'tier': 'full', 'format': 'rgba16', 'display': 'prophoto'})
            width, height = working['image']['width'], working['image']['height']
            assert working['image']['color_space'] == 'ProPhoto RGB'
            for target in ('prophoto', 'srgb', 'display-p3', 'adobe-rgb', 'rec2020'):
                reference, expected = call('render', {'session': sid, 'tier': 'full', 'format': 'rgba16', 'display': target})
                path = os.path.join(tmp, target + '.tif')
                written, _ = call('write_working_image', {
                    'path': path, 'width': width, 'height': height, 'format': 'tiff16',
                    'source_color_space': 'prophoto', 'color_space': target,
                }, pixels)
                assert written['color_space'] == reference['image']['color_space']
                values = struct.unpack('<' + 'H' * (len(expected) // 2), expected)
                reference_rgb = tuple(v for i, v in enumerate(values) if i % 4 != 3)
                assert rgb16(path) == reference_rgb, f'{target}: conversion differs from native render'
                tags = tiff_info(path)
                assert tags[34675][1] > 128, 'Missing ICC profile'
                checks += 2
                png_path=os.path.join(tmp,target+'.png')
                call('write_working_image',{'path':png_path,'width':width,'height':height,'format':'png16',
                    'source_color_space':'prophoto','color_space':target},pixels)
                assert png16(png_path)==reference_rgb,f'{target}: PNG16 lost or changed samples'
                checks+=1
                converted,encoded=call('convert_pixels',{'width':width,'height':height,'source':'prophoto','target':target,'format':'rgba16'},pixels)
                assert converted['image']['format']=='rgba16'
                converted_values=struct.unpack('<'+'H'*(len(encoded)//2),encoded)
                assert tuple(v for i,v in enumerate(converted_values)if i%4!=3)==reference_rgb
                # A target-to-display proof must be colourimetric: gamut
                # mapping was already applied when producing the target.
                proof,viewed=call('convert_pixels',{'width':width,'height':height,'source':target,'target':'srgb','format':'rgba8','colorimetric':True},encoded)
                assert proof['image']['format']=='rgba8' and len(viewed)==width*height*4
                checks+=2
            # The method must actually transform, rather than simply swapping
            # a profile tag on ProPhoto numbers. A mixed colour ramp catches it.
            assert rgb16(os.path.join(tmp, 'srgb.tif')) != rgb16(os.path.join(tmp, 'prophoto.tif'))
            checks += 1
            for changes in ({'source_color_space': 'unknown'}, {'source_color_space': None}):
                bad = os.path.join(tmp, 'refused.tif')
                q = {'path': bad, 'width': width, 'height': height, 'format': 'tiff16', 'color_space': 'srgb'}
                q.update({k: v for k, v in changes.items() if v is not None})
                head, _ = host.call('write_working_image', q, pixels)
                assert not head['ok'] and head['error']['code'] == 'bad_request'
                assert not os.path.exists(bad)
                checks += 1
            call('close', {'session': sid})
        call('shutdown')
        assert host.p.wait(timeout=20) == 0
    finally:
        if host.p.poll() is None:
            host.p.kill()
            host.p.wait(timeout=10)
    print(f'PASS: {checks} native working-space export checks (synthetic input)')


if __name__ == '__main__':
    main()
