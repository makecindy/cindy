import json, io, re
d=json.load(open('r5.json',encoding='utf-8'))
out=io.open('r5.txt','w',encoding='utf-8')
known={'4528270674','4528270688','4528270704','4528270716','4528270729','4528337061','4528337068','4528337073','4528337079','4532300910','4532300919','4532319542','4532564254','4532621365','4532684441'}
for c in d:
    if c['user']['login']=='zyjisdog': continue
    if str(c['id']) in known: continue
    b=re.sub(r'<[^>]+>','',(c.get('body') or '').split('<details>')[0]).strip()
    out.write('='*70+'\nid %s | reply_to %s | %s | %s:%s\n%s\n' % (c['id'], c.get('in_reply_to_id'), c['user']['login'], c['path'], c.get('original_line') or c.get('line'), b[:1500]))
out.close()
print('new:', open('r5.txt',encoding='utf-8').read().count('id '))
