#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
发布前校验：App 内置的 pk-node-workspace.zip 是否等于 pk-node 当前 HEAD。

workspace 的 INCLUDE 白名单（见 tools/export-app-workspace.js）：
  package.json, server.js, src/**, public/**
  bin/keystream.bin, bin/native/lre.so, bin/native/lre_pk.so

只要这些文件与 pk-node HEAD 一致，就说明内置的就是最新代码，无需重新导出。
"""
import os, sys, zipfile, hashlib

WS = '/root/cn.apixiaoyuan.app/app/src/main/assets/pk-node-workspace.zip'
PK = '/root/pk-node'

INCLUDE_DIRS = ['src', 'public']
INCLUDE_FILES = ['package.json', 'server.js', 'bin/keystream.bin',
                 'bin/native/lre.so', 'bin/native/lre_pk.so']


def sha(b):
    return hashlib.sha256(b).hexdigest()[:16]


zf = zipfile.ZipFile(WS)
names = zf.namelist()
print('workspace 条目数:', len(names))

# 期望集合
expect = set()
for d in INCLUDE_DIRS:
    for root, _, files in os.walk(os.path.join(PK, d)):
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), PK)
            expect.add(rel.replace(os.sep, '/'))
for f in INCLUDE_FILES:
    if os.path.exists(os.path.join(PK, f)):
        expect.add(f)

actual = set(n for n in names if not n.endswith('/'))
# 去掉可能的顶层目录前缀
prefix = ''
if actual and not any(n.startswith('package.json') for n in actual):
    cand = sorted(actual)[0].split('/')[0]
    prefix = cand + '/'
actual_norm = {n[len(prefix):] if prefix and n.startswith(prefix) else n for n in actual}

print('zip 内顶层前缀:', repr(prefix))
print('期望文件数:', len(expect), ' zip 内文件数:', len(actual_norm))

only_zip = sorted(actual_norm - expect)
only_repo = sorted(expect - actual_norm)
print('\n只在 zip 里（多出的）:', len(only_zip))
for n in only_zip[:20]:
    print('   +', n)
print('\n只在仓库里（缺的）:', len(only_repo))
for n in only_repo[:20]:
    print('   -', n)

# 逐文件比对内容
diffs = []
for rel in sorted(expect & actual_norm):
    disk = os.path.join(PK, rel)
    with open(disk, 'rb') as fh:
        a = sha(fh.read())
    b = sha(zf.read(prefix + rel))
    if a != b:
        diffs.append(rel)

print('\n内容不一致的文件:', len(diffs))
for n in diffs[:30]:
    print('   !', n)

# package.json 版本
import json
pkg_zip = json.loads(zf.read(prefix + 'package.json').decode())
pkg_disk = json.load(open(os.path.join(PK, 'package.json')))
print('\nzip 内版本 :', pkg_zip.get('version'))
print('仓库版本   :', pkg_disk.get('version'))

same = (not diffs) and (not only_repo)
print('\n>>> 结论:', '一致，无需重新导出' if same else '不一致，需要重新导出 workspace')
sys.exit(0 if same else 2)