# WCAG 2.x contrast of the palette proposed in docs/plans/claudio-rebrand.md. usage: python3 -I contrast.py
import sys
def lum(h):
    h=h.lstrip('#'); c=[int(h[i:i+2],16)/255 for i in (0,2,4)]
    c=[x/12.92 if x<=0.04045 else ((x+0.055)/1.055)**2.4 for x in c]
    return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
def cr(a,b):
    la,lb=sorted([lum(a),lum(b)],reverse=True); return (la+0.05)/(lb+0.05)
D=dict(bg='#0B1020',sunken='#0E1427',elev='#121A30',hover='#17233D',bg4='#1F2D4D',
       text='#F4F7FF',muted='#A7B1C9',faint='#8B96B1',accent='#6E9BFF',violet='#A78BFA',
       live='#00E5FF',ok='#4ade9a',warn='#f0b95c',bad='#f87b7f',gt1='#7DA4FF',gt2='#B9A4FF')
L=dict(bg='#F7F8FC',sunken='#EEF1F8',elev='#FFFFFF',hover='#E8ECF5',bg4='#DAE0EE',
       text='#0B1020',muted='#4A5470',faint='#5D6783',accent='#1D58DB',violet='#6D28D9',
       live='#0b6680',ok='#166534',warn='#854d0e',bad='#b91c1c',gt1='#1D58DB',gt2='#6D28D9')
grad=['#1F5FE8','#3D57E0','#6A4BD6']
for name,T in (('dark',D),('light',L)):
    print(f'== {name}')
    for fg in ('text','muted','faint','accent','violet','live','ok','warn','bad','gt1','gt2'):
        print(f'  {fg:7} on bg {cr(T[fg],T["bg"]):5.2f}  elev {cr(T[fg],T["elev"]):5.2f}  hover {cr(T[fg],T["hover"]):5.2f}')
print('== white on --grad stops', [round(cr('#FFFFFF',g),2) for g in grad])
print('== brand blue #246BFD: on white', round(cr('#246BFD','#FFFFFF'),2), ' on Deep Space', round(cr('#246BFD','#0B1020'),2))
print('== accent vs info (dark) old info #6cb6ff vs accent', round(cr('#6cb6ff',D['accent']),2))
