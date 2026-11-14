import json, matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.patches import Rectangle
M=json.load(open('/tmp/build/manifest.json'))
OUT='/home/claude/Arrangement_Stencils/Arrangement_Maps.pdf'
def color(kind):
    k=kind
    if 'hook' in k or 'chorus' in k or k=='final': return '#E4572E'
    if 'verse' in k: return '#2E86AB'
    if k in('pre','build','post','inst','inter','vamp'): return '#F2A541'
    if k in('bridge','bridge_up','break','drop_out','switch'): return '#8E5EA2'
    return '#7A8B99'
with PdfPages(OUT) as pdf:
    for n,m in enumerate(M):
        fig=plt.figure(figsize=(11,8.5)); T=m['tracks']; total=m['bars']
        mm,ss=int(m['seconds']//60),int(m['seconds']%60)
        fig.text(0.05,0.94,f"{m['genre'].replace('RnB','R&B')}  {m['idx']:02d}  {m['name']}",fontsize=20,weight='bold')
        fig.text(0.05,0.905,f"{m['bpm']} BPM   |   {total} bars   |   {mm}:{ss:02d}   |   4/4",fontsize=11,color='#444')
        fig.text(0.05,0.878,m['desc'],fontsize=11,style='italic',color='#444')
        a1=fig.add_axes([0.17,0.66,0.79,0.17]); a2=fig.add_axes([0.17,0.09,0.79,0.53])
        xs=[];ys=[]
        for s in m['sections']:
            c=color(s['kind']); x0=s['start']; w=s['bars']
            a1.add_patch(Rectangle((x0,0),w,s['energy'],color=c,alpha=.85,lw=0))
            a1.text(x0+w/2,10.6,s['label'],ha='center',va='bottom',fontsize=7.5,rotation=35 if w<=8 else 0,rotation_mode='anchor')
            a1.text(x0+w/2,s['energy']/2,f"{w}",ha='center',va='center',fontsize=9,color='white',weight='bold')
            for ti,t in enumerate(T):
                if t in s['active']:
                    a2.add_patch(Rectangle((x0+.15,len(T)-1-ti+.12),w-.3,.76,color=c,lw=0))
            for a in(a1,a2): a.axvline(x0,color='#bbb',lw=.6,zorder=0)
        a1.set_xlim(0,total); a1.set_ylim(0,10.5); a1.set_ylabel('Energy',fontsize=9); a1.set_xticks([]); a1.set_yticks([0,5,10])
        for sp in('top','right'): a1.spines[sp].set_visible(False)
        a2.set_xlim(0,total); a2.set_ylim(0,len(T))
        a2.set_yticks([len(T)-1-i+.5 for i in range(len(T))]); a2.set_yticklabels(T,fontsize=9)
        ticks=[s['start'] for s in m['sections']]+[total]
        a2.set_xticks(ticks); a2.set_xticklabels([str(t+1) for t in ticks],fontsize=8)
        a2.set_xlabel('Bar number where each section starts',fontsize=9)
        a2.tick_params(length=0)
        for i in range(len(T)+1): a2.axhline(i,color='#eee',lw=.6,zorder=0)
        for sp in a2.spines.values(): sp.set_color('#ccc')
        leg=[('Hook / Chorus','#E4572E'),('Verse','#2E86AB'),('Pre / Build / Post','#F2A541'),('Bridge / Break / Switch','#8E5EA2'),('Intro / Outro','#7A8B99')]
        x=0.17
        for l,c in leg:
            fig.patches.append(Rectangle((x,0.025),0.012,0.014,transform=fig.transFigure,color=c)); fig.text(x+0.016,0.027,l,fontsize=8); x+=0.165
        pdf.savefig(fig)
        if n==0: fig.savefig('/tmp/build/p1.png',dpi=70)
        if n==13: fig.savefig('/tmp/build/p14.png',dpi=70)
        plt.close(fig)
