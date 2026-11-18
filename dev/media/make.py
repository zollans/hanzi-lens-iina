import subprocess as sp
lines=[l for l in open("lines.txt",encoding="utf-8").read().splitlines() if l.strip()]
def dur(p): return float(sp.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",p]).decode())
def ts(t):
    h=int(t//3600); m=int(t%3600//60); s=t%60
    return ("%02d:%02d:%06.3f"%(h,m,s)).replace(".",",")
t=1.0; srt=[]; ins=[]; filt=""
for i,l in enumerate(lines):
    f="l%d.aiff"%(i+1)
    sp.check_call(["say","-v","Tingting","-r","170","-o",f,l])
    d=dur(f); ms=int(t*1000)
    srt.append("%d\n%s --> %s\n%s\n"%(i+1,ts(t),ts(t+d+0.25),l))
    ins+=["-i",f]; filt+="[%d:a]adelay=%d|%d[a%d];"%(i,ms,ms,i)
    t+=d+0.9
open("demo.srt","w",encoding="utf-8").write("\n".join(srt))
total=t+1.5; n=len(lines)
filt+="".join("[a%d]"%i for i in range(n))+"amix=inputs=%d:normalize=0[aout]"%n
sp.check_call(["ffmpeg","-v","error","-y",*ins,"-f","lavfi","-i","gradients=s=1280x720:c0=0x1f3a4d:c1=0x5a4636:c2=0x2c4a3a:n=3:speed=0.008:d=%.2f"%total,
  "-filter_complex",filt,"-map","%d:v"%n,"-map","[aout]","-c:v","libx264","-pix_fmt","yuv420p","-preset","veryfast","-c:a","aac","-t","%.2f"%total,"demo.mp4"])
sp.check_call(["ffmpeg","-v","error","-y","-i","demo.mp4","-i","demo.srt","-map","0","-map","1","-c","copy","-c:s","srt","-metadata:s:s:0","language=chi","embedded.mkv"])
print("total",total)
