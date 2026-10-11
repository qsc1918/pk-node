const path=require('node:path');
const fs=require('node:fs');
const ROOT='/root/pk-node';
const {request,CookieJar}=require(path.join(ROOT,'src','http'));
const native=require(path.join(ROOT,'src','native'));

const raw=JSON.parse(fs.readFileSync('/tmp/dev_cookies_now.json','utf8'));
const SWITCH='/leo-gateway/android/accounts/switch';

(async()=>{
  const jar=new CookieJar(JSON.parse(JSON.stringify(raw)));
  const u=new URL('https://xyks.yuanfudao.com'+SWITCH);
  for(const [k,v] of [['_productId','611'],['platform','android37'],['version','3.141.1'],['vendor','UC'],['av','5'],['deviceCategory','phone'],['webviewVersion','150'],['whRatio','2.17'],['isBackground','0']]) u.searchParams.set(k,v);
  u.searchParams.set('YFD_U','511467407');
  u.searchParams.set('sign', native.calcSign(SWITCH,{version:'3.141.1'}));
  const r=await request({url:u.toString(),method:'POST',jar,body:'targetUserId=1157242893',headers:Object.assign(require(path.join(ROOT,'src','leo')).mainDomainHeaders(),{'Content-Type':'application/x-www-form-urlencoded; charset=utf-8'})});
  console.log('switch →', r.status);
  console.log('body:', String(r.text).slice(0,150).replace(/\\s+/g,' '));
  if(r.headers['x-block-by']) console.log('blockBy:',r.headers['x-block-by']);
  process.exit(0);
})();
