import mido, os, re, json
from mido import MidiFile, MidiTrack, Message, MetaMessage
OUT='/home/claude/Arrangement_Stencils'
TPB=480; BAR=TPB*4

G={}
G['Trap']=dict(bpm=140,tracks=['808','Kick','Clap-Snare','Hi-Hats','Perc','Melody','Counter Melody','Pad','FX','Lead Vocal','Adlibs'],
 kinds={
 'intro':(3,'Melody,Pad,FX'),'tag':(3,'Melody,FX,Adlibs'),
 'hook':(9,'808,Kick,Clap-Snare,Hi-Hats,Perc,Melody,Counter Melody,Pad,FX,Lead Vocal,Adlibs'),
 'hook_lite':(6,'808,Clap-Snare,Hi-Hats,Melody,Pad,Lead Vocal'),
 'final':(10,'808,Kick,Clap-Snare,Hi-Hats,Perc,Melody,Counter Melody,Pad,FX,Lead Vocal,Adlibs'),
 'verse':(6,'808,Kick,Clap-Snare,Hi-Hats,Melody,Lead Vocal'),
 'verse_b':(7,'808,Kick,Clap-Snare,Hi-Hats,Perc,Melody,Counter Melody,Lead Vocal,Adlibs'),
 'verse_lite':(4,'808,Hi-Hats,Melody,Lead Vocal'),
 'pre':(5,'Clap-Snare,Hi-Hats,Melody,Pad,FX,Lead Vocal'),
 'build':(6,'Clap-Snare,Hi-Hats,Melody,FX,Lead Vocal'),
 'drop_out':(2,'Melody,FX,Lead Vocal'),
 'bridge':(4,'808,Melody,Pad,FX,Lead Vocal'),
 'switch':(2,'Pad,FX'),
 'p2_verse':(7,'808,Kick,Clap-Snare,Hi-Hats,Counter Melody,Pad,Lead Vocal,Adlibs'),
 'p2_hook':(9,'808,Kick,Clap-Snare,Hi-Hats,Perc,Counter Melody,Pad,FX,Lead Vocal,Adlibs'),
 'outro':(2,'Melody,Pad,FX'),'outro_beat':(4,'808,Kick,Hi-Hats,Melody')},
 stencils=[
 ('Classic Hook-First','Hook up front, two verses. The standard trap layout.',
  [('Intro','intro',8),('Hook 1','hook',16),('Verse 1a','verse',16),('Verse 1b','verse_b',8),('Hook 2','hook',16),('Verse 2a','verse',16),('Verse 2b','verse_b',8),('Hook 3','final',16),('Outro','outro',8)]),
 ('Short Streaming','Under 2:30. Tag, straight into the hook, no wasted bars.',
  [('Tag','tag',4),('Hook 1','hook',16),('Verse 1','verse',16),('Hook 2','hook',16),('Verse 2','verse_b',16),('Hook 3','final',8),('Outro','outro',4)]),
 ('Verse-First Slow Burn','Hold the hook back. Energy climbs across a long first verse.',
  [('Intro','intro',8),('Verse 1a','verse_lite',8),('Verse 1b','verse',16),('Build','build',4),('Hook 1','hook',16),('Verse 2','verse_b',24),('Hook 2','hook',16),('Bridge','bridge',8),('Final Hook','final',16),('Outro','outro',4)]),
 ('Beat Switch','Two-part track: new melody and drum feel after the switch.',
  [('Intro','intro',8),('Hook 1','hook',16),('Verse 1','verse',24),('Hook 2','hook',16),('Switch','switch',4),('Part II Verse','p2_verse',24),('Part II Hook','p2_hook',16),('Outro','outro_beat',8)]),
 ('Melodic With Pre-Hook','Sung/melodic trap. Pre-hooks lift into each hook, stripped bridge.',
  [('Intro','intro',8),('Verse 1','verse',16),('Pre-Hook 1','pre',8),('Hook 1','hook',16),('Verse 2','verse_b',16),('Pre-Hook 2','pre',8),('Hook 2','hook',16),('Bridge','bridge',8),('Final Hook','final',16),('Outro','outro',8)]),
 ])

G['RnB']=dict(bpm=80,tracks=['Kick','Snare','Hats','Perc','Bass','Keys','Guitar','Pad','FX','Lead Vocal','BG Vocals'],
 kinds={
 'intro':(2,'Keys,Pad,FX'),'intro_vox':(3,'Keys,Pad,BG Vocals'),
 'verse':(5,'Kick,Snare,Hats,Bass,Keys,Lead Vocal'),
 'verse_b':(6,'Kick,Snare,Hats,Perc,Bass,Keys,Guitar,Lead Vocal'),
 'verse_lite':(3,'Keys,Pad,Lead Vocal'),
 'pre':(6,'Kick,Hats,Bass,Keys,Pad,FX,Lead Vocal,BG Vocals'),
 'chorus':(8,'Kick,Snare,Hats,Perc,Bass,Keys,Guitar,Pad,Lead Vocal,BG Vocals'),
 'chorus_lite':(5,'Bass,Keys,Pad,Lead Vocal,BG Vocals'),
 'final':(10,'Kick,Snare,Hats,Perc,Bass,Keys,Guitar,Pad,FX,Lead Vocal,BG Vocals'),
 'post':(7,'Kick,Snare,Hats,Bass,Keys,Guitar,BG Vocals'),
 'bridge':(4,'Bass,Keys,Pad,FX,Lead Vocal'),
 'bridge_up':(7,'Kick,Snare,Hats,Bass,Keys,Pad,Guitar,Lead Vocal,BG Vocals'),
 'break':(2,'Pad,FX,BG Vocals'),
 'vamp':(7,'Kick,Snare,Hats,Perc,Bass,Keys,Guitar,Lead Vocal,BG Vocals'),
 'outro':(2,'Keys,Pad,BG Vocals')},
 stencils=[
 ('Classic Verse-Pre-Chorus','The standard R&B song form with a bridge before the last chorus.',
  [('Intro','intro',4),('Verse 1','verse',16),('Pre-Chorus 1','pre',4),('Chorus 1','chorus',8),('Verse 2','verse_b',16),('Pre-Chorus 2','pre',4),('Chorus 2','chorus',8),('Bridge','bridge',8),('Final Chorus','final',16),('Outro','outro',4)]),
 ('Short Streaming','Around 2:30. Chorus arrives inside the first 40 seconds.',
  [('Intro','intro_vox',2),('Verse 1','verse',8),('Pre-Chorus 1','pre',4),('Chorus 1','chorus',8),('Verse 2','verse_b',8),('Pre-Chorus 2','pre',4),('Chorus 2','final',8),('Outro','outro',4)]),
 ('Chorus-First','Opens on a stripped chorus so the hook lands before the first verse.',
  [('Chorus 0 (stripped)','chorus_lite',8),('Verse 1','verse',16),('Chorus 1','chorus',8),('Post-Chorus','post',4),('Verse 2','verse_b',16),('Chorus 2','chorus',8),('Post-Chorus','post',4),('Bridge','bridge',8),('Final Chorus','final',8),('Outro','outro',4)]),
 ('Slow Jam Build','Drums stay out until the first chorus. Long vamp ending for ad-libs.',
  [('Intro','intro',4),('Verse 1 (no drums)','verse_lite',16),('Pre-Chorus 1','pre',4),('Chorus 1','chorus',8),('Verse 2','verse',16),('Pre-Chorus 2','pre',4),('Chorus 2','chorus',8),('Bridge','bridge_up',8),('Final Chorus','final',8),('Vamp Out','vamp',8),('Outro','outro',4)]),
 ('Stripped Breakdown','Everything drops to pads and vocals mid-song, then rebuilds.',
  [('Intro','intro_vox',4),('Verse 1','verse',12),('Chorus 1','chorus',8),('Verse 2','verse_b',12),('Chorus 2','chorus',8),('Breakdown','break',4),('Bridge','bridge',8),('Chorus (stripped)','chorus_lite',8),('Final Chorus','final',8),('Outro','outro',4)]),
 ])

G['Afrobeats']=dict(bpm=104,tracks=['Kick','Rim-Snare','Shaker','Congas-Perc','Bass-Log Drum','Keys','Guitar','Lead Synth-Horns','Pad','FX','Lead Vocal','BG Vocals-Chants'],
 kinds={
 'intro':(3,'Guitar,Keys,Shaker,FX'),'intro_perc':(4,'Shaker,Congas-Perc,Rim-Snare,Guitar'),
 'intro_dj':(4,'Kick,Shaker,Congas-Perc,Rim-Snare'),
 'verse':(6,'Kick,Rim-Snare,Shaker,Bass-Log Drum,Keys,Guitar,Lead Vocal'),
 'verse_b':(7,'Kick,Rim-Snare,Shaker,Congas-Perc,Bass-Log Drum,Keys,Guitar,Lead Vocal,BG Vocals-Chants'),
 'verse_feat':(7,'Kick,Rim-Snare,Shaker,Congas-Perc,Bass-Log Drum,Keys,Pad,Lead Vocal'),
 'pre':(5,'Shaker,Congas-Perc,Keys,Guitar,Pad,FX,Lead Vocal'),
 'chorus':(9,'Kick,Rim-Snare,Shaker,Congas-Perc,Bass-Log Drum,Keys,Guitar,Lead Synth-Horns,Pad,Lead Vocal,BG Vocals-Chants'),
 'final':(10,'Kick,Rim-Snare,Shaker,Congas-Perc,Bass-Log Drum,Keys,Guitar,Lead Synth-Horns,Pad,FX,Lead Vocal,BG Vocals-Chants'),
 'post':(8,'Kick,Rim-Snare,Shaker,Congas-Perc,Bass-Log Drum,Guitar,Lead Synth-Horns,BG Vocals-Chants'),
 'inst':(7,'Kick,Rim-Snare,Shaker,Congas-Perc,Bass-Log Drum,Keys,Guitar,Lead Synth-Horns'),
 'break':(3,'Shaker,Congas-Perc,Pad,FX,BG Vocals-Chants'),
 'bridge':(5,'Shaker,Bass-Log Drum,Keys,Pad,Lead Vocal'),
 'outro':(3,'Shaker,Guitar,Keys,BG Vocals-Chants'),
 'outro_dj':(4,'Kick,Shaker,Congas-Perc,Rim-Snare')},
 stencils=[
 ('Classic Verse-Chorus','Standard Afrobeats form: groove never fully stops, chorus adds chants and lead line.',
  [('Intro','intro',8),('Verse 1','verse',16),('Chorus 1','chorus',16),('Verse 2','verse_b',16),('Chorus 2','chorus',16),('Bridge','bridge',8),('Final Chorus','final',16),('Outro','outro',8)]),
 ('Short Streaming','Around 2:20. Short intro, chorus by bar 13.',
  [('Intro','intro',4),('Verse 1','verse',8),('Chorus 1','chorus',16),('Verse 2','verse_b',8),('Chorus 2','final',16),('Outro','outro',8)]),
 ('Chorus-First With Post-Chorus','Hook opens the song. Instrumental post-chorus gives the dance moment.',
  [('Intro','intro_perc',4),('Chorus 1','chorus',8),('Post-Chorus','post',8),('Verse 1','verse',16),('Chorus 2','chorus',8),('Post-Chorus','post',8),('Verse 2','verse_b',16),('Final Chorus','final',16),('Outro','outro',8)]),
 ('Extended DJ Edit','Percussion-only intro and outro for mixing, instrumental break in the middle.',
  [('DJ Intro','intro_dj',16),('Verse 1','verse',16),('Pre-Chorus','pre',8),('Chorus 1','chorus',16),('Instrumental','inst',8),('Verse 2','verse_b',16),('Pre-Chorus','pre',8),('Chorus 2','final',16),('DJ Outro','outro_dj',16)]),
 ('Feature And Breakdown','Second verse for a guest, percussion breakdown before the last chorus.',
  [('Intro','intro',8),('Verse 1','verse',16),('Pre-Chorus','pre',4),('Chorus 1','chorus',16),('Feature Verse','verse_feat',16),('Pre-Chorus','pre',4),('Chorus 2','chorus',16),('Breakdown','break',8),('Final Chorus','final',16),('Outro','outro',8)]),
 ])

G['Rap']=dict(bpm=90,tracks=['Kick','Snare','Hats','Perc','Bass-808','Sample-Melody','Keys','Scratches-FX','Lead Vocal','Doubles-Adlibs'],
 kinds={
 'intro':(3,'Sample-Melody,Scratches-FX'),'intro_beat':(4,'Kick,Snare,Hats,Sample-Melody'),
 'verse':(6,'Kick,Snare,Hats,Bass-808,Sample-Melody,Lead Vocal'),
 'verse_b':(7,'Kick,Snare,Hats,Perc,Bass-808,Sample-Melody,Lead Vocal,Doubles-Adlibs'),
 'verse_lite':(4,'Bass-808,Sample-Melody,Lead Vocal'),
 'verse_alt':(7,'Kick,Snare,Hats,Perc,Bass-808,Keys,Lead Vocal,Doubles-Adlibs'),
 'drop_out':(2,'Sample-Melody,Lead Vocal'),
 'hook':(9,'Kick,Snare,Hats,Perc,Bass-808,Sample-Melody,Keys,Lead Vocal,Doubles-Adlibs'),
 'final':(10,'Kick,Snare,Hats,Perc,Bass-808,Sample-Melody,Keys,Scratches-FX,Lead Vocal,Doubles-Adlibs'),
 'inter':(4,'Kick,Snare,Hats,Bass-808,Sample-Melody,Scratches-FX'),
 'bridge':(4,'Bass-808,Keys,Scratches-FX,Lead Vocal'),
 'switch':(2,'Keys,Scratches-FX'),
 'outro':(3,'Sample-Melody,Keys,Scratches-FX'),'outro_beat':(5,'Kick,Snare,Hats,Bass-808,Sample-Melody')},
 stencils=[
 ('Classic 16s And 8s','Three 16-bar verses, 8-bar hooks. The traditional rap song form.',
  [('Intro','intro',4),('Verse 1','verse',16),('Hook 1','hook',8),('Verse 2','verse_b',16),('Hook 2','hook',8),('Verse 3','verse_b',16),('Hook 3','final',8),('Outro','outro_beat',8)]),
 ('Short Streaming','About 2:20. Hook first, two short verses.',
  [('Intro','intro',2),('Hook 1','hook',8),('Verse 1','verse',12),('Hook 2','hook',8),('Verse 2','verse_b',12),('Hook 3','final',8),('Outro','outro',2)]),
 ('One Long Verse','No hook. A single verse that keeps adding layers, with drop-outs for punchlines.',
  [('Intro','intro',4),('Verse a','verse_lite',8),('Verse b','verse',16),('Drop-Out','drop_out',2),('Verse c','verse_b',14),('Drop-Out','drop_out',2),('Verse d','verse_b',14),('Outro','outro_beat',8)]),
 ('Storytelling With Bridge','Two long verses, bridge shifts the mood before the last hook.',
  [('Intro','intro_beat',4),('Verse 1','verse',24),('Hook 1','hook',8),('Verse 2','verse_b',24),('Hook 2','hook',8),('Bridge','bridge',8),('Final Hook','final',8),('Outro','outro',4)]),
 ('Posse Cut With Beat Change','Three verses for different voices, interludes between, beat flips for the last one.',
  [('Intro','intro_beat',4),('Verse 1','verse',16),('Hook 1','hook',8),('Verse 2','verse_b',16),('Hook 2','hook',8),('Interlude','inter',4),('Switch','switch',2),('Verse 3 (new beat)','verse_alt',16),('Final Hook','final',8),('Outro','outro',4)]),
 ])

def slug(s): return re.sub(r'[^A-Za-z0-9]+','_',s).strip('_')
manifest=[]
for g,d in G.items():
    os.makedirs(f'{OUT}/{g}',exist_ok=True)
    for i,(name,desc,secs) in enumerate(d['stencils'],1):
        mf=MidiFile(type=1,ticks_per_beat=TPB)
        c=MidiTrack(); mf.tracks.append(c)
        c.append(MetaMessage('track_name',name=f'{g} - {name}',time=0))
        c.append(MetaMessage('set_tempo',tempo=mido.bpm2tempo(d['bpm']),time=0))
        c.append(MetaMessage('time_signature',numerator=4,denominator=4,time=0))
        last=0;pos=0;spans=[]
        for lab,kind,bars in secs:
            t=pos*BAR
            c.append(MetaMessage('marker',text=f'{lab} ({bars})',time=t-last)); last=t
            spans.append((lab,kind,pos,bars)); pos+=bars
        c.append(MetaMessage('marker',text='END',time=pos*BAR-last))
        c.append(MetaMessage('end_of_track',time=0))
        total=pos
        # guide track: one note per section, pitch steps so sections are distinguishable
        names=['SECTIONS GUIDE']+d['tracks']
        for ti,tn in enumerate(names):
            tr=MidiTrack(); mf.tracks.append(tr)
            tr.append(MetaMessage('track_name',name=tn,time=0))
            last=0
            for si,(lab,kind,st,bars) in enumerate(spans):
                active = ti==0 or tn in d['kinds'][kind][1].split(',')
                if not active: continue
                note = 60+(si%2)*2 if ti==0 else 60
                on=st*BAR; off=(st+bars)*BAR-TPB//4
                tr.append(Message('note_on',note=note,velocity=1,channel=min(ti,15) if ti!=9 else 15,time=on-last))
                tr.append(Message('note_off',note=note,velocity=0,channel=min(ti,15) if ti!=9 else 15,time=off-on)); last=off
            tr.append(MetaMessage('end_of_track',time=total*BAR-last))
        fn=f'{OUT}/{g}/{g}_{i:02d}_{slug(name)}_{d["bpm"]}bpm.mid'
        mf.save(fn)
        secs_len=total*4*60/d['bpm']
        manifest.append(dict(genre=g,idx=i,name=name,desc=desc,bpm=d['bpm'],bars=total,seconds=secs_len,file=fn,tracks=d['tracks'],
            sections=[dict(label=l,kind=k,start=s,bars=b,energy=d['kinds'][k][0],active=d['kinds'][k][1].split(',')) for l,k,s,b in spans]))
        # sanity: all active names exist
        for k,(e,ts) in d['kinds'].items():
            for t in ts.split(','): assert t in d['tracks'],(g,k,t)
json.dump(manifest,open('/tmp/build/manifest.json','w'))
for m in manifest: print(f"{m['genre']:10} {m['name']:32} {m['bars']:4} bars {int(m['seconds']//60)}:{int(m['seconds']%60):02d}")
