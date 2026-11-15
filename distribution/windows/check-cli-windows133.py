#!/usr/bin/env python3
"""Check actual console-subsystem Windows CLI stdio in Wine 10."""
import json,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[2]
cli='/work/desktop/src-tauri/target/x86_64-pc-windows-gnu/release/spektralab-cli.exe'
base=['docker','exec','-i','-e','WINEDEBUG=-all','-e','WINEPREFIX=/work/build/wine10-prefix','spektralab-wine10','/usr/lib/wine/wine64',cli]
def run(args,data=None):
 p=subprocess.run(base+args,input=data,text=True,capture_output=True,timeout=60)
 return p,[json.loads(line) for line in p.stdout.splitlines() if line.strip()]
p,rows=run(['status']);assert p.returncode==0 and rows[0]['access']==False and rows[0]['version']=='1.3.3',(p,rows)
p,rows=run(['schema']);assert p.returncode==2 and rows[0]['error']['code']=='refused',(p,rows)
requests=[{'jsonrpc':'2.0','id':i,'method':method} for i,method in enumerate(['initialize','ping','tools/list','unknown'])]
requests.append({'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'get_schema','arguments':{}}})
p,rows=run(['mcp'],'\n'.join(map(json.dumps,requests))+'\n');assert p.returncode==0 and len(rows)==5,(p,rows)
assert rows[0]['result']['serverInfo']['version']=='1.3.3'
assert rows[1]['result']=={} and len(rows[2]['result']['tools'])==12
assert rows[3]['error']['code']==-32601 and rows[4]['result']['isError']
assert json.loads(rows[4]['result']['content'][0]['text'])['error']['code']=='refused'
print('PASS: Windows CLI UTF-8 stdio, exit status, access refusal, MCP initialize/ping/12 tools/error/refusal')
