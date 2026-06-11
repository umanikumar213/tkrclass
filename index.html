<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Attendance · TKR</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#070711; --violet:#7c5cff; --cyan:#22d3ee; --magenta:#ff4d9d;
    --green:#34f5c5; --red:#ff5d6c; --amber:#ffc14d;
    --glass:rgba(255,255,255,.045); --glass-bd:rgba(255,255,255,.10);
    --txt:#eef0ff; --muted:#9aa0c4;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{min-height:100%}
  body{
    font-family:'Inter',system-ui,sans-serif;color:var(--txt);
    background:var(--bg);overflow-x:hidden;position:relative;
  }
  /* animated aurora background */
  .bg{position:fixed;inset:0;z-index:-2;background:
     radial-gradient(60% 50% at 15% 10%,#1a0b3e 0%,transparent 60%),
     radial-gradient(55% 45% at 90% 0%,#08263f 0%,transparent 55%),
     radial-gradient(60% 60% at 50% 100%,#2a0b33 0%,transparent 60%),var(--bg);}
  .orb{position:fixed;border-radius:50%;filter:blur(70px);opacity:.55;z-index:-1;animation:float 18s ease-in-out infinite}
  .orb.v{width:420px;height:420px;background:#6d4bff;top:-120px;left:-80px}
  .orb.c{width:380px;height:380px;background:#1bb6d6;bottom:-120px;right:-60px;animation-delay:-6s}
  .orb.m{width:300px;height:300px;background:#ff3d8b;top:40%;left:55%;animation-delay:-11s;opacity:.4}
  @keyframes float{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(40px,-30px) scale(1.08)}66%{transform:translate(-30px,25px) scale(.95)}}

  .top{padding:26px 20px 6px;text-align:center}
  .top .badge{display:inline-flex;align-items:center;gap:8px;font-size:12px;letter-spacing:2px;
    text-transform:uppercase;color:var(--cyan);border:1px solid rgba(34,211,238,.3);
    padding:6px 14px;border-radius:30px;background:rgba(34,211,238,.06)}
  .top h1{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:30px;margin-top:14px;
    background:linear-gradient(90deg,#fff,#b9a8ff 40%,#7ee7ff);-webkit-background-clip:text;background-clip:text;color:transparent}
  .top p{color:var(--muted);font-size:13px;margin-top:4px}

  .wrap{max-width:760px;margin:0 auto;padding:24px 16px 70px}

  .card{background:var(--glass);border:1px solid var(--glass-bd);border-radius:22px;
    backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);margin-bottom:20px;overflow:hidden;
    box-shadow:0 10px 40px rgba(0,0,0,.35);opacity:0;transform:translateY(24px);animation:rise .7s cubic-bezier(.2,.8,.2,1) forwards}
  .card:nth-child(1){animation-delay:.05s}.card:nth-child(2){animation-delay:.13s}
  .card:nth-child(3){animation-delay:.21s}.card:nth-child(4){animation-delay:.29s}.card:nth-child(5){animation-delay:.37s}
  @keyframes rise{to{opacity:1;transform:none}}
  .ch{padding:16px 22px;font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:14px;letter-spacing:.5px;
    display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,.06)}
  .ch .dot{width:8px;height:8px;border-radius:50%;background:var(--cyan);box-shadow:0 0 12px var(--cyan)}

  /* login */
  .login{max-width:430px;margin:6vh auto 0}
  .login .inner{padding:34px 30px}
  .login h2{font-family:'Space Grotesk',sans-serif;font-size:22px;font-weight:600;text-align:center;margin-bottom:6px}
  .login .sub{text-align:center;color:var(--muted);font-size:13px;margin-bottom:24px}
  label{display:block;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
  input{width:100%;padding:14px 16px;font-size:16px;color:#fff;background:rgba(255,255,255,.05);
    border:1px solid var(--glass-bd);border-radius:14px;outline:none;transition:.25s;font-family:inherit}
  input:focus{border-color:var(--violet);box-shadow:0 0 0 4px rgba(124,92,255,.18)}
  #roll{text-transform:uppercase;letter-spacing:2px}
  .btn{width:100%;margin-top:18px;padding:15px;border:none;border-radius:14px;cursor:pointer;
    font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:15px;color:#0a0a18;position:relative;overflow:hidden;
    background:linear-gradient(100deg,var(--cyan),var(--violet) 55%,var(--magenta));
    background-size:200% 100%;transition:.4s;box-shadow:0 8px 30px rgba(124,92,255,.4)}
  .btn:hover{background-position:100% 0;transform:translateY(-2px)}
  .btn:active{transform:translateY(0) scale(.99)}
  .btn:disabled{opacity:.6;cursor:not-allowed}
  .err{margin-top:14px;padding:12px 14px;border-radius:12px;font-size:13px;display:none;
    background:rgba(255,93,108,.12);border:1px solid rgba(255,93,108,.35);color:#ffb3bb}

  /* student head */
  .stu{padding:22px;display:flex;align-items:center;gap:16px}
  .ava{width:58px;height:58px;border-radius:18px;flex-shrink:0;display:flex;align-items:center;justify-content:center;
    font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:20px;color:#0a0a18;
    background:linear-gradient(135deg,var(--cyan),var(--violet));box-shadow:0 6px 20px rgba(124,92,255,.45)}
  .stu .nm{font-family:'Space Grotesk',sans-serif;font-size:21px;font-weight:600}
  .stu .rl{color:var(--muted);font-size:13px;letter-spacing:2px;margin-top:3px}

  /* ring */
  .ring-wrap{padding:24px;display:flex;align-items:center;gap:28px;flex-wrap:wrap;justify-content:center}
  .ring{position:relative;width:170px;height:170px;flex-shrink:0}
  .ring svg{transform:rotate(-90deg)}
  .ring .ctr{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
  .ring .ctr b{font-family:'Space Grotesk',sans-serif;font-size:34px;font-weight:700}
  .ring .ctr span{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-top:2px}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;flex:1;min-width:250px}
  .stat{background:rgba(255,255,255,.04);border:1px solid var(--glass-bd);border-radius:16px;padding:16px 10px;text-align:center}
  .stat b{font-family:'Space Grotesk',sans-serif;font-size:26px;display:block}
  .stat span{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
  .stat.pre b{color:var(--green)} .stat.abs b{color:var(--red)}

  /* periods */
  .sub-note{padding:4px 22px 0;font-size:12px;color:var(--muted)}
  .day-h{padding:16px 22px 2px;font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:16px}
  .periods{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;padding:14px 22px 22px}
  @media(max-width:560px){.periods{grid-template-columns:repeat(3,1fr)}}
  .pcell{border-radius:14px;padding:12px 6px;text-align:center;border:1px solid var(--glass-bd);
    background:rgba(255,255,255,.03);min-height:64px;display:flex;flex-direction:column;justify-content:center;gap:3px;
    opacity:0;transform:scale(.85);animation:pop .45s cubic-bezier(.2,1.4,.4,1) forwards}
  @keyframes pop{to{opacity:1;transform:none}}
  .pcell .pno{font-size:10px;letter-spacing:1px;color:var(--muted)}
  .pcell .st{font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:13px}
  .pcell .sb{font-size:10px;color:var(--muted)}
  .pcell.present{background:rgba(34,211,238,.1);border-color:rgba(34,211,238,.45);box-shadow:0 0 18px rgba(34,211,238,.25) inset}
  .pcell.present .st{color:var(--cyan)}
  .pcell.absent{background:rgba(255,93,108,.1);border-color:rgba(255,93,108,.45);box-shadow:0 0 18px rgba(255,93,108,.22) inset}
  .pcell.absent .st{color:var(--red)}
  .pcell.dash .st{color:#555a7a}

  /* calculator */
  .calc{padding:22px}
  .calc .row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
  .calc .fld{flex:1;min-width:130px}
  .calc input{text-transform:none;letter-spacing:0}
  .calc .go{padding:14px 22px;border:none;border-radius:14px;cursor:pointer;font-family:'Space Grotesk',sans-serif;
    font-weight:600;color:#0a0a18;background:linear-gradient(100deg,var(--violet),var(--magenta));box-shadow:0 6px 20px rgba(255,77,157,.35);transition:.3s}
  .calc .go:hover{transform:translateY(-2px)}
  .presets{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
  .preset{background:rgba(255,255,255,.05);border:1px solid var(--glass-bd);color:var(--txt);
    border-radius:30px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:.25s;font-family:'Space Grotesk',sans-serif}
  .preset:hover{border-color:var(--violet);background:rgba(124,92,255,.18)}
  .out{margin-top:18px;padding:18px;border-radius:16px;background:rgba(124,92,255,.08);
    border:1px solid rgba(124,92,255,.3);font-size:14px;line-height:1.6;display:none}
  .out .big{font-family:'Space Grotesk',sans-serif;font-size:30px;font-weight:700;
    background:linear-gradient(90deg,var(--cyan),var(--magenta));-webkit-background-clip:text;background-clip:text;color:transparent}
  .out .days{display:block;margin-top:6px;color:var(--muted);font-size:13px}

  /* subjects */
  .subj{padding:10px 22px 18px}
  .srow{display:flex;align-items:center;gap:14px;padding:13px 0;border-bottom:1px solid rgba(255,255,255,.05)}
  .srow:last-child{border-bottom:none}
  .srow .nm{font-family:'Space Grotesk',sans-serif;font-weight:600;width:90px;flex-shrink:0}
  .srow .bar{flex:1;height:8px;border-radius:8px;background:rgba(255,255,255,.07);overflow:hidden}
  .srow .bar i{display:block;height:100%;border-radius:8px;width:0;transition:width 1s cubic-bezier(.2,.8,.2,1)}
  .srow .val{width:96px;text-align:right;font-size:13px;font-family:'Space Grotesk',sans-serif;font-weight:600}
  .ok{color:var(--green)} .lo{color:var(--red)}

  .back{display:block;margin:8px auto 0;padding:13px 26px;border:1px solid var(--glass-bd);background:rgba(255,255,255,.05);
    color:var(--txt);border-radius:14px;cursor:pointer;font-family:'Space Grotesk',sans-serif;font-weight:600;transition:.25s}
  .back:hover{border-color:var(--magenta);background:rgba(255,77,157,.12)}

  @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="bg"></div><div class="orb v"></div><div class="orb c"></div><div class="orb m"></div>

<div class="top">
  <span class="badge"><span style="width:6px;height:6px;border-radius:50%;background:var(--cyan);display:inline-block"></span> TKR · Live</span>
  <h1>Attendance Dashboard</h1>
  <p>Track your attendance · know exactly where you stand</p>
</div>

<div class="wrap">
  <!-- Login -->
  <div class="card login" id="loginBox"><div class="inner">
    <h2>Sign in</h2>
    <div class="sub">Enter your roll number to continue</div>
    <label for="roll">Roll Number</label>
    <input id="roll" placeholder="24K95A6718" autocomplete="off" />
    <button class="btn" id="btn" onclick="go()">View my attendance →</button>
    <div class="err" id="err"></div>
  </div></div>

  <!-- Result -->
  <div id="result" style="display:none">
    <div class="card">
      <div class="stu">
        <div class="ava" id="ava">—</div>
        <div><div class="nm" id="nm">—</div><div class="rl" id="rl">—</div></div>
      </div>
    </div>

    <div class="card" id="latestCard">
      <div class="ch"><span class="dot"></span> Latest attendance</div>
      <div class="day-h" id="dayHead">—</div>
      <div class="sub-note">Cyan = present · Red = absent · — = not marked yet</div>
      <div class="periods" id="periods"></div>
    </div>

    <div class="card">
      <div class="ch"><span class="dot"></span> Overall</div>
      <div class="ring-wrap">
        <div class="ring">
          <svg width="170" height="170" viewBox="0 0 170 170">
            <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#7c5cff"/></linearGradient></defs>
            <circle cx="85" cy="85" r="70" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="14"/>
            <circle id="prog" cx="85" cy="85" r="70" fill="none" stroke="url(#g)" stroke-width="14"
              stroke-linecap="round" stroke-dasharray="439.8" stroke-dashoffset="439.8"
              style="transition:stroke-dashoffset 1.3s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 0 8px rgba(34,211,238,.6))"/>
          </svg>
          <div class="ctr"><b id="pct">0%</b><span>overall</span></div>
        </div>
        <div class="stats">
          <div class="stat"><b id="sCon">0</b><span>Held</span></div>
          <div class="stat pre"><b id="sPre">0</b><span>Present</span></div>
          <div class="stat abs"><b id="sAbs">0</b><span>Absent</span></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="ch"><span class="dot"></span> Attendance calculator</div>
      <div class="calc">
        <div class="row">
          <div class="fld"><label for="target">Target %</label>
            <input id="target" type="number" min="1" max="99" placeholder="e.g. 75" /></div>
          <button class="go" onclick="calc()">Calculate</button>
        </div>
        <div class="presets">
          <button class="preset" onclick="quick(50)">50%</button>
          <button class="preset" onclick="quick(65)">65%</button>
          <button class="preset" onclick="quick(70)">70%</button>
          <button class="preset" onclick="quick(75)">75%</button>
        </div>
        <div class="out" id="out"></div>
      </div>
    </div>

    <div class="card" id="subjCard">
      <div class="ch"><span class="dot"></span> Subject-wise</div>
      <div class="subj" id="subj"></div>
    </div>

    <button class="back" onclick="logout()">← Check another</button>
  </div>
</div>

<script>
let DATA=null;
const CIRC=439.8;

async function go(){
  const roll=document.getElementById('roll').value.trim();
  const btn=document.getElementById('btn'),err=document.getElementById('err');
  err.style.display='none';
  if(!roll){err.style.display='block';err.textContent='Please enter your roll number.';return;}
  btn.disabled=true;btn.textContent='Loading…';
  try{
    const r=await fetch('/login',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({rollNumber:roll})});
    const d=await r.json();
    btn.disabled=false;btn.textContent='View my attendance →';
    if(!d.success){err.style.display='block';err.textContent='⚠ '+d.message;return;}
    DATA=d;render(d);
  }catch(e){
    btn.disabled=false;btn.textContent='View my attendance →';
    err.style.display='block';err.textContent='⚠ Cannot reach server. Is "node server.js" running?';
  }
}

function initials(n){return (n||'').split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase()||'?';}

function render(d){
  document.getElementById('loginBox').style.display='none';
  document.getElementById('result').style.display='block';
  document.getElementById('nm').textContent=d.name||'—';
  document.getElementById('rl').textContent=d.rollNo||'—';
  document.getElementById('ava').textContent=initials(d.name);

  // latest day
  const lc=document.getElementById('latestCard');
  if(d.latestDay&&d.latestDay.periods){
    document.getElementById('dayHead').textContent=d.latestDay.date+'  ·  '+d.latestDay.weekday;
    document.getElementById('periods').innerHTML=d.latestDay.periods.map((p,i)=>{
      const lbl=p.status==='present'?'Present':p.status==='absent'?'Absent':'—';
      const sb=p.subject?`<div class="sb">${p.subject}</div>`:'';
      return `<div class="pcell ${p.status}" style="animation-delay:${i*70}ms"><div class="pno">P${i+1}</div><div class="st">${lbl}</div>${sb}</div>`;
    }).join('');
  }else{lc.style.display='none';}

  // ring + count up
  const pct=parseFloat(d.overall||(d.summary&&d.summary.percentage)||0)||0;
  const prog=document.getElementById('prog');
  setTimeout(()=>{prog.style.strokeDashoffset=CIRC*(1-pct/100);},150);
  countUp(document.getElementById('pct'),pct,'%');
  const col=pct<65?'#ff5d6c':(pct<75?'#ffc14d':'#34f5c5');
  prog.style.filter=`drop-shadow(0 0 8px ${col})`;
  prog.setAttribute('stroke', col);
  if(d.summary){
    countUp(document.getElementById('sCon'),d.summary.conducted,'');
    countUp(document.getElementById('sPre'),d.summary.present,'');
    countUp(document.getElementById('sAbs'),d.summary.absent,'');
  }

  // subjects with bars
  const s=document.getElementById('subj');
  if(d.perSubject&&d.perSubject.length){
    s.innerHTML=d.perSubject.map(x=>{
      const [a,h]=(x.attended||'').split('/').map(Number);
      const p=h?Math.round(a/h*100):null;
      const cls=p===null?'':(p<65?'lo':'ok');
      const barc=p===null?'#555a7a':(p<65?'var(--red)':(p<75?'var(--amber)':'var(--green)'));
      return `<div class="srow"><div class="nm">${x.subject}</div>
        <div class="bar"><i data-w="${p||0}" style="background:${barc}"></i></div>
        <div class="val ${cls}">${x.attended}${p!==null?` · ${p}%`:''}</div></div>`;
    }).join('');
    setTimeout(()=>document.querySelectorAll('.srow .bar i').forEach(b=>b.style.width=b.dataset.w+'%'),250);
  }else{document.getElementById('subjCard').style.display='none';}
}

function countUp(el,to,suf){
  const dur=1100,st=performance.now();
  const dec=(suf==='%'&&to%1!==0)?2:0;
  function step(t){
    const k=Math.min(1,(t-st)/dur);const e=1-Math.pow(1-k,3);
    el.textContent=(to*e).toFixed(dec)+suf;
    if(k<1)requestAnimationFrame(step);else el.textContent=to.toFixed(dec)+suf;
  }
  requestAnimationFrame(step);
}

function quick(v){document.getElementById('target').value=v;calc();}

function calc(){
  const out=document.getElementById('out');
  const t=parseFloat(document.getElementById('target').value);
  if(!DATA||!DATA.summary)return;
  if(!(t>0&&t<100)){out.style.display='block';out.innerHTML='Enter a target between 1 and 99.';return;}
  const C=DATA.summary.conducted,P=DATA.summary.present;
  const cur=C?(P/C*100):0;
  out.style.display='block';
  if(cur>=t){
    const skip=Math.max(0,Math.floor((100*P-t*C)/t));
    out.innerHTML=`You're at <b>${cur.toFixed(2)}%</b> — already above ${t}% ✨<br>
      You can miss <span class="big">${skip}</span> more class(es) and stay at ${t}%.
      <span class="days">≈ ${Math.floor(skip/6)} day(s) off (at 6 classes/day)</span>`;
  }else{
    const need=Math.ceil((t*C-100*P)/(100-t));
    out.innerHTML=`You're at <b>${cur.toFixed(2)}%</b>. To hit ${t}% attend the next<br>
      <span class="big">${need}</span> class(es) without missing any.
      <span class="days">≈ ${Math.ceil(need/6)} full day(s) of college (at 6 classes/day)</span>`;
  }
}

function logout(){
  document.getElementById('result').style.display='none';
  document.getElementById('loginBox').style.display='block';
  document.getElementById('roll').value='';
  document.getElementById('out').style.display='none';
  document.getElementById('prog').style.strokeDashoffset=CIRC;
  DATA=null;
}
document.getElementById('roll').addEventListener('keypress',e=>{if(e.key==='Enter')go();});
</script>
</body>
</html>
