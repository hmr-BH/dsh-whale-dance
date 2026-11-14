/**
 * dsh-whale-dance — 浏览器半区（V2）。
 *
 * 设计要点：
 * - 不再隐藏/复制小鲸鱼挂件：直接移动真实挂件的 left/top，让它在下半区左右来回跳；
 * - 音响紧贴鲸鱼左侧，歌词只取关键句放进鲸鱼旁边的聊天气泡里循环展示；
 * - 迪斯科球用分面镜球 + 光束 + 镜头光斑 + 节拍闪光的组合，避免一团模糊光晕；
 * - 跟随低音做窗口级轻微抖动（作用于应用根节点），并给聊天框/侧边栏加霓虹描边；
 * - 没装前置挂件时：插件加载后提示安装；触发蹦迪时仍播放音乐/灯光，但不显示鲸鱼。
 */

window.__ModuleLoader__.load({
  id: 'dsh-whale-dance',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-whale-dance'
    const STATE_URL = '/dsh-dance/state.json?cv=20'
    const STOP_URL = '/dsh-dance/stop'
    const POLL_MS = 1000
    const KEY_MS = 6200
    const KEY_DELAY_MS = 12000
    const Z_INDEX = 13000
    const VOLUME_KEY = 'dsh-whale-dance:volume'
    const DEFAULT_VOLUME = 0.9

    /** 读取持久化的音量设置；无效值回落到默认音量。 */
    function loadVolume() {
      try {
        const raw = window.localStorage.getItem(VOLUME_KEY)
        if (raw === null) return DEFAULT_VOLUME
        const value = Number(raw)
        if (!Number.isFinite(value)) return DEFAULT_VOLUME
        return Math.min(1, Math.max(0, value))
      } catch {
        return DEFAULT_VOLUME
      }
    }

    /** 写入持久化音量；失败时不打断播放。 */
    function saveVolume(value) {
      try { window.localStorage.setItem(VOLUME_KEY, String(value)) } catch {}
    }

    const DICT = {
      zh: {
        dj: 'B站 DJ 版',
        original: 'B站 原版',
        synth: '合成节拍',
        endHint: '按 ESC 结束蹦迪',
        tapToPlay: '▶ 点击播放音乐',
        tapBeat: '♫ 开启节拍',
        stopNow: '结束',
        volume: '音量',
        loading: '正在准备蹦迪…',
        noLyric: '♪',
        prereqTitle: '还没安装小鲸鱼挂件',
        prereqBody: '这个插件的前置插件 dsh-whale-widget 没检测到。装好挂件后鲸鱼才会跟着跳；现在只播放音乐、灯光和歌词。可以在「插件」页面安装 dsh-whale-widget。',
        prereqOk: '知道了',
      },
      en: {
        dj: 'Bilibili DJ remix',
        original: 'Bilibili original',
        synth: 'Synth beat',
        endHint: 'Press ESC to stop',
        tapToPlay: '▶ Tap to play music',
        tapBeat: '♫ Start beat',
        stopNow: 'Stop',
        volume: 'Volume',
        loading: 'Preparing the dance…',
        noLyric: '♪',
        prereqTitle: 'Whale widget not installed',
        prereqBody: 'The required dsh-whale-widget plugin was not detected. Install it for the dancing whale; for now only music, lights and lyrics are shown. Install it from the Plugins page.',
        prereqOk: 'Got it',
      },
    }

    const CSS = [
      '.dwhd-stage{position:fixed;inset:0;z-index:' + Z_INDEX + ';pointer-events:none;overflow:hidden;',
      'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;--dwhd-energy:0;--dwhd-beat:0;}',
      '.dwhd-stage *{box-sizing:border-box;}',
      // 让真实挂件在蹦迪期间不接收拖拽/点击
      '.dshwv-root.dwhd-dancing,.dshwv-root.dwhd-dancing *{pointer-events:none!important;transition:none!important;}',
      // —— 迪斯科球 ——
      '.dwhd-orb-wrap{position:absolute;left:50%;top:2.1vh;width:min(40vw,460px);height:min(40vw,460px);',
      'transform:translateX(-50%);pointer-events:none;--dwhd-ball:clamp(78px,12vh,132px);}',
      '.dwhd-cone{position:absolute;left:50%;top:calc(var(--dwhd-ball) / 2);width:min(72vw,760px);height:min(78vh,780px);',
      'transform:translateX(-50%);clip-path:polygon(50% 0,18% 100%,82% 100%);',
      'background:linear-gradient(180deg,rgba(150,210,255,.18),rgba(140,110,255,.05) 55%,transparent);',
      'opacity:calc(.25 + var(--dwhd-energy) * .35);filter:blur(2px);}',
      '.dwhd-beam{position:absolute;left:50%;top:calc(var(--dwhd-ball) / 2);width:min(92vw,980px);height:min(92vw,980px);',
      'border-radius:50%;transform:translate(-50%,-50%);mix-blend-mode:screen;filter:blur(.6px);',
      'opacity:calc(.14 + var(--dwhd-energy) * .42);}',
      '.dwhd-beam-a{background:conic-gradient(from 0deg,rgba(255,120,220,.30),rgba(255,120,220,0) 12%,',
      'rgba(96,196,255,.28) 21%,rgba(96,196,255,0) 33%,rgba(255,228,120,.26) 45%,rgba(255,228,120,0) 57%,',
      'rgba(120,255,200,.26) 69%,rgba(120,255,200,0) 81%,rgba(255,120,220,.30));',
      '-webkit-mask-image:radial-gradient(circle,transparent 25%,#000 28%,#000 63%,transparent 72%);',
      'mask-image:radial-gradient(circle,transparent 25%,#000 28%,#000 63%,transparent 72%);',
      'animation:dwhd-spin 13s linear infinite;}',
      '.dwhd-beam-b{background:conic-gradient(from 90deg,rgba(130,150,255,.3),transparent 18%,',
      'rgba(255,160,230,.3),transparent 38%,rgba(120,240,255,.28),transparent 62%,rgba(255,200,120,.28),',
      'transparent 82%,rgba(130,150,255,.3));opacity:calc(.12 + var(--dwhd-energy) * .34);',
      'animation:dwhd-spin-b 21s linear infinite;}',
      '.dwhd-halo{position:absolute;left:50%;top:calc(var(--dwhd-ball) / 2);',
      'width:calc(var(--dwhd-ball) * 2.6);height:calc(var(--dwhd-ball) * 2.6);transform:translate(-50%,-50%);',
      'border-radius:50%;mix-blend-mode:screen;opacity:calc(.18 + var(--dwhd-energy) * .4);',
      'background:conic-gradient(from 0deg,rgba(255,95,225,.9),rgba(90,220,255,.9),rgba(255,230,120,.85),',
      'rgba(160,110,255,.9),rgba(255,95,225,.9));',
      '-webkit-mask-image:radial-gradient(circle,transparent 54%,#000 57%,#000 68%,transparent 73%);',
      'mask-image:radial-gradient(circle,transparent 54%,#000 57%,#000 68%,transparent 73%);',
      'animation:dwhd-spin 5.2s linear infinite;}',
      '.dwhd-ray{position:absolute;left:50%;top:calc(var(--dwhd-ball) / 2);width:min(18vw,210px);height:min(56vh,520px);',
      'transform-origin:50% 0;transform:translateX(-50%) rotate(0deg);',
      'mix-blend-mode:screen;filter:blur(6px);will-change:transform;',
      '-webkit-mask-image:linear-gradient(180deg,#000 0%,#000 46%,transparent 100%);',
      'mask-image:linear-gradient(180deg,#000 0%,#000 46%,transparent 100%);',
      'opacity:calc(.16 + var(--dwhd-energy) * .34);}',
      '.dwhd-ray-a{background:linear-gradient(180deg,rgba(255,95,225,.45),rgba(255,95,225,0) 72%);',
      'animation:dwhd-ray-sweep 6.4s ease-in-out infinite alternate;}',
      '.dwhd-ray-b{background:linear-gradient(180deg,rgba(80,220,255,.4),rgba(80,220,255,0) 76%);',
      'animation:dwhd-ray-sweep 8.1s ease-in-out infinite alternate-reverse;}',
      '.dwhd-ray-c{background:linear-gradient(180deg,rgba(255,220,110,.32),rgba(160,110,255,0) 80%);',
      'animation:dwhd-ray-sweep 9.6s ease-in-out infinite alternate;}',
      '.dwhd-flare{position:absolute;left:50%;top:calc(var(--dwhd-ball) / 2);',
      'width:min(34vw,380px);height:min(34vw,380px);transform:translate(-50%,-50%) rotate(12deg);',
      'background:radial-gradient(circle,rgba(170,220,255,.22) 0%,rgba(150,120,255,.08) 38%,transparent 66%);',
      'mix-blend-mode:screen;opacity:calc(.16 + var(--dwhd-energy) * .32);animation:dwhd-flare 9s ease-in-out infinite alternate;}',
      '.dwhd-flare::before,.dwhd-flare::after{content:"";position:absolute;left:50%;top:50%;',
      'background:linear-gradient(90deg,transparent,rgba(200,240,255,.55),transparent);',
      'transform:translate(-50%,-50%);filter:blur(3px);}',
      '.dwhd-flare::before{width:100%;height:1.5px;}',
      '.dwhd-flare::after{width:1.5px;height:100%;background:linear-gradient(180deg,transparent,rgba(200,240,255,.5),transparent);}',
      '.dwhd-mount{position:absolute;left:50%;top:-12px;width:2px;height:12px;transform:translateX(-50%);',
      'background:linear-gradient(180deg,#f2fbff,rgba(200,230,255,0));border-radius:1px;}',
      '.dwhd-ball-pulse{width:var(--dwhd-ball);height:var(--dwhd-ball);margin:0 auto;will-change:transform;',
      'transition:transform .06s linear;}',
      '.dwhd-ball{position:relative;width:var(--dwhd-ball);height:var(--dwhd-ball);margin:0 auto;border-radius:50%;',
      'transform:translateZ(0);filter:drop-shadow(0 0 14px rgba(120,200,255,.75)) drop-shadow(0 0 42px rgba(120,90,255,.45));',
      'animation:dwhd-ballspin 10s linear infinite;}',
      '.dwhd-ball svg{display:block;width:100%;height:100%;border-radius:50%;}',
      '.dwhd-pool{position:absolute;left:50%;bottom:-2vh;width:90vw;height:44vh;transform:translateX(-50%);',
      'background:radial-gradient(ellipse at 50% 100%,rgba(110,170,255,.26),rgba(150,90,255,.08) 45%,transparent 70%);',
      'mix-blend-mode:screen;opacity:calc(.25 + var(--dwhd-energy) * .5);pointer-events:none;}',
      '.dwhd-spark{position:absolute;width:4px;height:4px;border-radius:50%;background:#fff;',
      'box-shadow:0 0 8px 3px rgba(180,220,255,.75);animation:dwhd-twinkle 2.6s ease-in-out infinite;}',
      '.dwhd-spark:nth-child(2){left:31%;top:22%;animation-delay:.6s;background:#ffd1f0;}',
      '.dwhd-spark:nth-child(3){right:29%;top:18%;animation-delay:1.1s;}',
      '.dwhd-spark:nth-child(4){left:26%;bottom:26%;animation-delay:1.7s;background:#ffe9a8;}',
      '.dwhd-spark:nth-child(5){right:24%;bottom:22%;animation-delay:.3s;background:#b7ffe3;}',
      // 节拍闪光/氛围
      '.dwhd-flash{position:absolute;inset:0;pointer-events:none;mix-blend-mode:screen;',
      'background:radial-gradient(circle at 50% 22%,rgba(140,200,255,.4),rgba(150,100,255,.12) 38%,transparent 68%);',
      'opacity:calc(var(--dwhd-energy) * .22 + var(--dwhd-beat) * .32);}',
      // —— 音响 + 歌词气泡 ——
      '.dwhd-speaker{position:absolute;will-change:left,top,transform;opacity:0;transition:opacity .2s ease-out;',
      'filter:drop-shadow(0 10px 14px rgba(0,0,0,.5));transform-origin:50% 100%;}',
      '.dwhd-speaker svg{display:block;}',
      '.dwhd-cone-driver{transform-origin:center;animation:dwhd-driver .5s ease-in-out infinite;}',
      '.dwhd-cone-driver2{animation-delay:.25s;}',
      '.dwhd-speaker-ring{position:absolute;left:50%;top:30%;width:100%;height:46%;border-radius:50%;',
      'transform:translate(-50%,-50%);border:2px solid rgba(140,225,255,.7);opacity:0;',
      'animation:dwhd-ring 1.4s ease-out infinite;}',
      '.dwhd-bubble{position:absolute;width:min(72vw,286px);min-height:84px;padding:10px 14px 11px;border-radius:14px;',
      'background:linear-gradient(180deg,rgba(255,255,255,.99),rgba(238,247,255,.97));color:#20305a;',
      'border:1px solid rgba(140,200,255,.65);',
      'box-shadow:0 0 0 1px rgba(130,215,255,.3),0 0 22px rgba(90,180,255,.45),0 12px 28px rgba(0,0,0,.42);',
      'pointer-events:none;will-change:left,top,transform;opacity:0;transition:opacity .2s ease-out;}',
      '.dwhd-bubble::after{content:"";position:absolute;left:22px;bottom:-7px;width:13px;height:13px;',
      'transform:rotate(45deg);background:rgba(246,251,255,.98);border-right:1px solid rgba(140,200,255,.6);',
      'border-bottom:1px solid rgba(140,200,255,.6);}',
      '.dwhd-bubble-free{left:22px!important;top:auto!important;bottom:116px;transform:none!important;opacity:1!important;}',
      // 接管挂件原生泡泡：隐藏原生内容，只显示歌词
      '.dshwv-text.dwhd-lyric-mode{justify-content:center!important;white-space:normal!important;}',
      '.dshwv-text.dwhd-lyric-mode > *:not(.dwhd-native-lyric){display:none!important;}',
      '.dshwv-pop.dwhd-native-mode .dshwv-gif{display:none!important;opacity:0!important;}',
      '.dwhd-native-lyric{width:100%;display:flex;align-items:center;justify-content:center;text-align:center;',
      'font-size:clamp(12px,2.1vh,17px);font-weight:800;line-height:1.35;color:#203170;white-space:normal;',
      'word-break:break-word;padding:0 2px;}',
      '.dwhd-bubble-free::after{display:none;}',
      '.dwhd-bubble-head{display:flex;align-items:center;gap:7px;font-size:11px;color:#5d709c;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dwhd-bubble-title{font-weight:700;color:#22335f;max-width:56%;overflow:hidden;text-overflow:ellipsis;}',
      '.dwhd-badge{flex:0 0 auto;padding:1px 7px;border-radius:999px;background:rgba(90,150,255,.12);',
      'border:1px solid rgba(90,150,255,.32);color:#3660a8;font-size:10px;}',
      '.dwhd-bubble-link{flex:0 0 auto;color:#2e6bc4;text-decoration:none;pointer-events:auto;}',
      '.dwhd-bubble-link:hover{text-decoration:underline;}',
      '.dwhd-bubble-lyric{margin-top:6px;font-size:15px;line-height:1.4;font-weight:800;color:#17264d;',
      'min-height:21px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;',
      'transition:opacity .25s ease;}',
      '.dwhd-bubble-progress{margin-top:8px;height:3px;border-radius:3px;background:rgba(60,100,180,.16);overflow:hidden;}',
      '.dwhd-bubble-progress i{display:block;height:100%;width:0;border-radius:3px;',
      'background:linear-gradient(90deg,#2fa8ff,#8b6bff,#ff7fc4);}',
      // 提示/按钮
      // 右上角控制条：放在会话内容区右上（不压在标题栏上），位置随窗口重新测量
      '.dwhd-hint{position:absolute;right:18px;top:96px;display:flex;align-items:center;gap:10px;',
      'padding:7px 10px 7px 12px;border-radius:12px;background:rgba(10,10,28,.72);',
      'border:1px solid rgba(150,200,255,.3);color:#dfe9ff;font-size:12px;pointer-events:auto;',
      'box-shadow:0 0 16px rgba(80,170,255,.25);backdrop-filter:blur(6px);max-width:min(60vw,420px);',
      '-webkit-app-region:no-drag;app-region:no-drag;}',
      '.dwhd-hint > *{pointer-events:auto;}',
      '.dwhd-vol{display:flex;align-items:center;gap:7px;padding-left:10px;',
      'border-left:1px solid rgba(150,200,255,.24);}',
      '.dwhd-vol-icon{font-size:13px;line-height:1;opacity:.9;min-width:14px;text-align:center;}',
      '.dwhd-vol-range{-webkit-appearance:none;appearance:none;width:96px;height:4px;border-radius:3px;',
      'background:#2f7bff;outline:none;cursor:pointer;',
      'pointer-events:auto;touch-action:none;}',
      '.dwhd-vol-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:13px;height:13px;',
      'border-radius:50%;background:#f2fbff;border:1px solid rgba(120,200,255,.9);',
      'box-shadow:0 0 10px rgba(120,210,255,.9);cursor:pointer;}',
      '.dwhd-vol-range::-moz-range-thumb{width:13px;height:13px;border:1px solid rgba(120,200,255,.9);',
      'border-radius:50%;background:#f2fbff;box-shadow:0 0 10px rgba(120,210,255,.9);cursor:pointer;}',
      '.dwhd-vol-value{font-size:11px;color:#b9ccec;min-width:30px;text-align:right;font-variant-numeric:tabular-nums;}',
      '.dwhd-key{display:inline-block;padding:1px 7px;border-radius:5px;background:#e8eefc;color:#182238;',
      'font-size:11px;font-weight:700;box-shadow:0 2px 0 rgba(0,0,0,.35);}',
      '.dwhd-stop{pointer-events:auto;cursor:pointer;border:1px solid rgba(150,210,255,.5);border-radius:7px;',
      'padding:3px 9px;background:rgba(60,80,150,.5);color:#eaf3ff;font-size:12px;font-weight:700;}',
      '.dwhd-stop:hover{background:rgba(90,120,210,.6);}',
      '.dwhd-tap{position:absolute;left:50%;bottom:9vh;transform:translateX(-50%);pointer-events:auto;',
      'cursor:pointer;border:1px solid rgba(150,210,255,.55);border-radius:999px;padding:9px 20px;',
      'background:linear-gradient(180deg,#2b3766,#1b2145);color:#fff;font-size:13px;font-weight:600;',
      'box-shadow:0 8px 24px rgba(0,0,0,.45),0 0 18px rgba(120,200,255,.35);}',
      '.dwhd-tap:hover{background:linear-gradient(180deg,#35427a,#222a56);}',
      // 前置缺失提示
      '.dwhd-prereq{position:absolute;left:50%;top:13vh;transform:translateX(-50%);width:min(92vw,460px);',
      'pointer-events:auto;padding:14px 16px;border-radius:16px;color:#eaf3ff;',
      'background:linear-gradient(180deg,rgba(18,17,48,.96),rgba(9,9,26,.94));',
      'border:1px solid rgba(130,220,255,.55);',
      'box-shadow:0 0 0 1px rgba(120,200,255,.25),0 0 26px rgba(70,170,255,.4),0 16px 40px rgba(0,0,0,.45);}',
      '.dwhd-prereq h3{margin:0 0 6px;font-size:14px;color:#cfeaff;}',
      '.dwhd-prereq p{margin:0;font-size:12px;line-height:1.55;color:#b9c7e8;}',
      '.dwhd-prereq button{margin-top:10px;cursor:pointer;border:1px solid rgba(140,210,255,.55);',
      'border-radius:8px;padding:5px 14px;background:rgba(60,100,180,.36);color:#eef7ff;font-size:12px;}',
      // —— 霓虹：全彩灯带（粉/青/黄/绿循环），比之前更快 ——
      '.dwhd-neon{box-shadow:0 0 0 1px rgba(255,70,210,.75),0 0 18px rgba(255,70,210,.6),0 0 40px rgba(150,60,255,.4),',
      'inset 0 0 24px rgba(90,210,255,.16)!important;outline:1px solid rgba(255,255,255,.35);outline-offset:2px;',
      'animation:dwhd-neonpulse 1.15s linear infinite;}',
      '.dwhd-neon-frame{position:absolute;pointer-events:none;border:2px solid rgba(255,80,220,.95);',
      'border-radius:14px;box-shadow:0 0 10px rgba(255,80,220,.9),0 0 26px rgba(120,90,255,.7),inset 0 0 16px rgba(90,210,255,.25);',
      'animation:dwhd-rainbow 1.3s linear infinite;}',
      // 侧边栏条目、用户气泡等额外灯带（不改变元素自身圆角与内容颜色，只加外发光）
      '.dwhd-neon-item{box-shadow:0 0 0 1px rgba(255,80,220,.55),0 0 12px rgba(255,80,220,.45),',
      '0 0 24px rgba(90,200,255,.32)!important;animation:dwhd-neonpulse-small 1.4s linear infinite;}',
      // 图标类（小尺寸）用更细更亮的圈
      '.dwhd-neon-icon{box-shadow:0 0 0 1px rgba(140,240,255,.7),0 0 10px rgba(140,240,255,.6)!important;',
      'animation:dwhd-neonpulse-tiny 1.1s linear infinite!important;}',
      // —— 金色传说：暖金光晕 ——
      '.dwhd-gold-frame{position:absolute;pointer-events:none;border-radius:16px;border:2px solid rgba(255,214,120,.8);',
      'box-shadow:0 0 16px rgba(255,200,80,.8),0 0 40px rgba(255,150,20,.55),inset 0 0 22px rgba(255,225,160,.3);',
      'animation:dwhd-gold-shine 2.1s ease-in-out infinite;}',
      '.dwhd-gold-aura{position:absolute;inset:-16px;border-radius:46%;pointer-events:none;',
      'background:radial-gradient(circle,rgba(255,222,140,.5),rgba(255,170,40,.22) 44%,transparent 72%);',
      'filter:blur(7px);mix-blend-mode:screen;animation:dwhd-gold-breathe 2.3s ease-in-out infinite;}',
      // 分裂层固定裁剪，内部内容独立旋转；这样中线不会跟着裁剪区域一起晃动。
      '.dwhd-split-layer{position:fixed;inset:0;z-index:90000;pointer-events:none;overflow:hidden;',
      'background:rgba(8,7,15,.96);}',
      '.dwhd-split-side{position:absolute;inset:0;overflow:hidden;}',
      '.dwhd-split-side.left{clip-path:inset(0 50% 0 0);}',
      '.dwhd-split-side.right{clip-path:inset(0 0 0 50%);}',
      '.dwhd-split-spin{position:absolute;inset:0;transform-origin:50% 50%;will-change:transform;}',
      '.dwhd-split-body{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;',
      'margin:0!important;overflow:hidden!important;background:transparent!important;}',
      '.dwhd-split-body .dwhd-stage{position:fixed!important;inset:0!important;}',
      '.dwhd-split-body .dshwv-root,.dwhd-split-body .dwhd-speaker,.dwhd-split-body .dwhd-bubble{display:none!important;}',
      '.dwhd-split-widget{position:fixed!important;right:auto!important;bottom:auto!important;',
      'margin:0!important;pointer-events:none!important;transition:none!important;will-change:left,top;z-index:95000!important;}',
      '.dwhd-split-widget .dshwv-pop{pointer-events:none!important;}',
      '.dwhd-split-speaker{position:fixed!important;right:auto!important;bottom:auto!important;',
      'pointer-events:none!important;transition:none!important;will-change:left,top,transform;z-index:95001!important;}',
      '.dwhd-split-layer::after{content:"";position:absolute;left:50%;top:0;width:1px;height:100%;z-index:98000;',
      'background:linear-gradient(180deg,transparent,rgba(140,220,255,.75),transparent);box-shadow:0 0 16px rgba(120,210,255,.65);}',
      '@keyframes dwhd-spin{to{transform:translate(-50%,-50%) rotate(360deg);}}',
      '@keyframes dwhd-spin-b{to{transform:translate(-50%,-50%) rotate(-360deg);}}',
      '@keyframes dwhd-ballspin{to{transform:rotate(360deg);}}',
      '@keyframes dwhd-flare{from{transform:translate(-50%,-50%) rotate(4deg) scale(.94);}to{transform:translate(-50%,-50%) rotate(22deg) scale(1.05);}}',
      '@keyframes dwhd-ray-sweep{from{transform:translateX(-50%) rotate(-20deg);}to{transform:translateX(-50%) rotate(20deg);}}',
      '@keyframes dwhd-twinkle{0%,100%{opacity:.25;transform:scale(.6);}50%{opacity:1;transform:scale(1.3);}}',
      '@keyframes dwhd-driver{0%,100%{transform:scale(1);}50%{transform:scale(1.14);}}',
      '@keyframes dwhd-ring{0%{opacity:.6;transform:translate(-50%,-50%) scale(.5);}100%{opacity:0;transform:translate(-50%,-50%) scale(1.45);}}',
      '@keyframes dwhd-rainbow{from{filter:hue-rotate(0deg);}to{filter:hue-rotate(360deg);}}',
      '@keyframes dwhd-neonpulse-small{',
      '0%{box-shadow:0 0 0 1px rgba(255,80,220,.6),0 0 12px rgba(255,80,220,.5),0 0 24px rgba(90,200,255,.3)!important;}',
      '33%{box-shadow:0 0 0 1px rgba(90,220,255,.6),0 0 12px rgba(90,220,255,.5),0 0 26px rgba(0,180,255,.34)!important;}',
      '66%{box-shadow:0 0 0 1px rgba(255,225,90,.62),0 0 12px rgba(255,210,70,.52),0 0 26px rgba(255,160,0,.34)!important;}',
      '100%{box-shadow:0 0 0 1px rgba(255,80,220,.6),0 0 12px rgba(255,80,220,.5),0 0 24px rgba(90,200,255,.3)!important;}}',
      '@keyframes dwhd-neonpulse-tiny{',
      '0%{box-shadow:0 0 0 1px rgba(140,240,255,.7),0 0 10px rgba(140,240,255,.6)!important;}',
      '50%{box-shadow:0 0 0 1px rgba(255,120,230,.7),0 0 10px rgba(255,120,230,.6)!important;}',
      '100%{box-shadow:0 0 0 1px rgba(255,225,120,.72),0 0 10px rgba(255,225,120,.6)!important;}}',
      '@keyframes dwhd-neonpulse{',
      '0%{box-shadow:0 0 0 1px rgba(255,70,210,.75),0 0 18px rgba(255,70,210,.6),0 0 40px rgba(150,60,255,.4),inset 0 0 24px rgba(90,210,255,.16)!important;}',
      '25%{box-shadow:0 0 0 1px rgba(80,220,255,.8),0 0 20px rgba(80,220,255,.6),0 0 44px rgba(0,140,255,.42),inset 0 0 24px rgba(120,255,220,.16)!important;}',
      '50%{box-shadow:0 0 0 1px rgba(255,232,90,.8),0 0 20px rgba(255,210,60,.6),0 0 44px rgba(255,150,0,.42),inset 0 0 24px rgba(255,205,120,.16)!important;}',
      '75%{box-shadow:0 0 0 1px rgba(130,255,150,.8),0 0 20px rgba(90,240,140,.6),0 0 44px rgba(0,200,120,.42),inset 0 0 24px rgba(180,255,200,.16)!important;}',
      '100%{box-shadow:0 0 0 1px rgba(255,70,210,.75),0 0 18px rgba(255,70,210,.6),0 0 40px rgba(150,60,255,.4),inset 0 0 24px rgba(90,210,255,.16)!important;}}',
      '@keyframes dwhd-gold-shine{0%,100%{opacity:.62;filter:brightness(1);}50%{opacity:1;filter:brightness(1.22);}}',
      '@keyframes dwhd-gold-spin{to{transform:rotate(360deg);}}',
      '@keyframes dwhd-gold-breathe{0%,100%{opacity:.55;transform:scale(1);}50%{opacity:1;transform:scale(1.07);}}',
      '@media (prefers-reduced-motion: reduce){.dwhd-beam,.dwhd-ball,.dwhd-spark,.dwhd-flare,.dwhd-cone-driver{animation:none;}}',
    ].join('\n')

    function formatTime(seconds) {
      const value = Math.max(0, Math.floor(Number(seconds) || 0))
      return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
    }

    function findWidget() {
      const root = document.querySelector('.dshwv-root') || document.querySelector('[class*="dshwv-root"]')
      if (!root) return null
      const img = root.querySelector('.dshwv-img') || root.querySelector('img')
      if (!img) return null
      const rect = img.getBoundingClientRect()
      if (!(rect.width > 20 && rect.height > 20)) return null
      return { root, img, rect }
    }

    function findAppRoot() {
      // 抖动作用在 body 上：鲸鱼挂件挂在 body 下、我们自己的舞台在应用根下，
      // 二者都在同一个 body 层叠上下文里，舞台的 z-index 仍然高于挂件，
      // 不会因为给应用根加 transform 而把挂件顶到舞台上面。
      const body = document.body
      if (!body) return null
      try {
        const rect = body.getBoundingClientRect()
        if (rect.width < window.innerWidth * 0.8 || rect.height < window.innerHeight * 0.8) return null
      } catch {
        return null
      }
      return body
    }

    function findComposerCard() {
      const input = document.querySelector('[data-composer-input="true"]')
        || document.querySelector('textarea') || document.querySelector('[contenteditable="true"]')
      if (!input) return null
      let node = input.parentElement
      for (let depth = 0; depth < 9 && node; depth += 1) {
        try {
          const style = window.getComputedStyle(node)
          const radius = parseFloat(style.borderTopLeftRadius) || 0
          const rect = node.getBoundingClientRect()
          if (radius >= 8 && rect.width >= 260 && rect.height >= 48) return node
        } catch {}
        node = node.parentElement
      }
      return null
    }

    /**
     * 测量提示条/音量条的落点：贴着会话内容区右上角，而不是压在标题栏上。
     * 竖向用标签条底边，横向用内容列右边缘；两者都取自真实 DOM，
     * 窗口缩放、最大化、侧栏变化时重新测量，因此不会错位。
     */
    function measureHintAnchor() {
      const viewportHeight = window.innerHeight
      const viewportWidth = window.innerWidth
      let top = null
      let columnRight = null
      let columnTop = null

      for (const strip of document.querySelectorAll('[role="tablist"], [class*="tablist" i], [class*="tab-bar" i]')) {
        try {
          const rect = strip.getBoundingClientRect()
          if (rect.width < 40 || rect.height < 8) continue
          if (rect.top > viewportHeight * 0.45 || rect.bottom < 8) continue
          top = rect.bottom + 14
          break
        } catch {}
      }

      const composer = findComposerCard()
      if (composer) {
        let node = composer.parentElement
        for (let depth = 0; depth < 10 && node; depth += 1) {
          try {
            const rect = node.getBoundingClientRect()
            if (rect.width >= viewportWidth * 0.45 && rect.height >= viewportHeight * 0.4
              && rect.right > viewportWidth * 0.4 && rect.right <= viewportWidth + 4) {
              if (columnRight === null || rect.right > columnRight) columnRight = rect.right
              if (rect.top >= 0 && rect.top < viewportHeight * 0.35) columnTop = rect.top
            }
          } catch {}
          node = node.parentElement
        }
      }

      if (top === null) top = columnTop !== null ? columnTop + 104 : 96

      // 内容列几乎贴到窗口右边时就是常规的 18px；存在右侧面板时才跟随列边缘。
      let right = 18
      if (columnRight !== null) {
        const gap = viewportWidth - columnRight
        right = Math.round(gap + 18)
      }

      const maxTop = Math.max(56, viewportHeight - 140)
      return {
        top: Math.round(Math.max(56, Math.min(maxTop, top))),
        right: Math.round(Math.max(12, Math.min(viewportWidth * 0.5, right))),
      }
    }

    /** 把元素换算成舞台坐标下的描边框。 */
    function rectOfElement(element) {
      if (!element) return null
      try {
        const rect = element.getBoundingClientRect()
        if (rect.width < 60 || rect.height < 20) return null
        let radius = 14
        try { radius = parseFloat(window.getComputedStyle(element).borderTopLeftRadius) || 0 } catch {}
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          radius: Math.max(8, Math.min(24, radius || 12)),
        }
      } catch {
        return null
      }
    }

    /**
     * 测量聊天框与侧边栏的霓虹描边位置。
     * 窗口缩放/最大化时需要重新调用，否则光条会停在旧坐标上。
     */
    function measureNeonRects() {
      try {
        return {
          composer: rectOfElement(findComposerCard()),
          sidebar: rectOfElement(findSidebar()),
        }
      } catch {
        return null
      }
    }

    /** 两个描边框是否几乎一致（避免 1px 抖动引起重排）。 */
    function rectsClose(a, b) {
      if (!a || !b) return a === b
      const near = (x, y) => Math.abs(Number(x) - Number(y)) < 2
      return near(a.left, b.left) && near(a.top, b.top) && near(a.width, b.width) && near(a.height, b.height)
    }

    function findSidebar() {
      const candidates = []
      const sideButtons = document.querySelectorAll('button, [role="button"], a')
      for (const button of sideButtons) {
        try {
          const text = String(button.textContent || '').replace(/\s+/g, '')
          if (!/新会话|newchat/i.test(text)) continue
          let node = button
          while (node && node.parentElement && node.parentElement !== document.body) {
            const rect = node.getBoundingClientRect()
            if (rect.left <= 100 && rect.width >= 160 && rect.width <= 520 && rect.height >= 300) {
              return node
            }
            node = node.parentElement
          }
        } catch {}
      }
      for (const element of document.querySelectorAll('aside, [class*="sidebar" i]')) {
        try {
          const rect = element.getBoundingClientRect()
          if (rect.width >= 160 && rect.width <= 520 && rect.height >= 300 && rect.left <= 140) {
            candidates.push({ element, area: rect.width * rect.height })
          }
        } catch {}
      }
      candidates.sort((a, b) => b.area - a.area)
      if (candidates.length > 0) return candidates[0].element
      const brand = document.querySelector('[class*="brand" i], [class*="logo" i]')
      let node = brand
      while (node && node.parentElement && node.parentElement !== document.body) {
        try {
          const rect = node.getBoundingClientRect()
          if (rect.width >= 160 && rect.width <= 520 && rect.height >= 300 && rect.left <= 140) return node
        } catch {}
        node = node.parentElement
      }
      return null
    }

    /** 找到会话内容列（消息所在的宽容器）。 */
    function findConversationColumn() {
      const composer = findComposerCard()
      if (!composer) return null
      let node = composer.parentElement
      let best = null
      for (let depth = 0; depth < 10 && node && node !== document.body; depth += 1) {
        try {
          const rect = node.getBoundingClientRect()
          if (rect.width >= window.innerWidth * 0.45 && rect.right <= window.innerWidth + 4) best = node
        } catch {}
        node = node.parentElement
      }
      return best
    }

    function hasVisibleBackground(element) {
      try {
        const style = window.getComputedStyle(element)
        const color = style.backgroundColor || ''
        if (!color || color === 'transparent') return false
        const match = /rgba?\(([^)]+)\)/.exec(color)
        if (!match) return true
        const parts = match[1].split(',').map((value) => Number(value.trim()))
        if (parts.length === 4 && parts[3] < 0.08) return false
        return true
      } catch {
        return false
      }
    }

    /**
     * 给真实界面元素加霓虹灯带：侧边栏条目、图标按钮、右侧对齐的用户发言气泡。
     * 只加类、不改布局，结束时按记录逐个移除。
     */
    function applyNeon() {
      const painted = new Map()
      const inStage = (element) => Boolean(element?.closest?.('.dwhd-stage'))

      const paint = (element, className) => {
        if (!element || inStage(element)) return
        try {
          if (!element.classList.contains(className)) element.classList.add(className)
          painted.set(element, className)
        } catch {}
      }

      const scanSidebar = () => {
        const sidebar = findSidebar()
        if (!sidebar) return
        const sidebarRect = sidebar.getBoundingClientRect()
        for (const element of sidebar.querySelectorAll('a, button, [role="button"], li, [class*="item" i], [class*="entry" i]')) {
          try {
            const rect = element.getBoundingClientRect()
            if (rect.width < 70 || rect.height < 18 || rect.height > 64) continue
            if (rect.width > sidebarRect.width + 4) continue
            if (rect.height <= 48 && rect.width <= 48) paint(element, 'dwhd-neon-icon')
            else paint(element, 'dwhd-neon-item')
          } catch {}
        }
      }

      const scanIcons = () => {
        const roots = [findComposerCard(), findSidebar()].filter(Boolean)
        for (const root of roots) {
          for (const element of root.querySelectorAll('button, [role="button"], svg')) {
            try {
              const rect = element.getBoundingClientRect()
              if (rect.width < 12 || rect.height < 12) continue
              if (rect.width > 52 || rect.height > 52) continue
              if (element.querySelector('.dwhd-neon-icon')) continue
              paint(element.tagName === 'svg' ? element.parentElement || element : element, 'dwhd-neon-icon')
            } catch {}
          }
        }
      }

      const scanUserBubbles = () => {
        const column = findConversationColumn()
        if (!column) return
        let columnRect = null
        try { columnRect = column.getBoundingClientRect() } catch { return }
        if (!columnRect || columnRect.width < 200) return
        const all = column.querySelectorAll('*')
        const count = all.length
        const start = Math.max(0, count - 320)
        const candidates = []
        for (let index = start; index < count; index += 1) {
          const element = all[index]
          if (inStage(element)) continue
          try {
            const rect = element.getBoundingClientRect()
            if (rect.width < 70 || rect.height < 26 || rect.height > 240) continue
            if (rect.width > columnRect.width * 0.78) continue
            // 右侧对齐（用户发言）才加灯带
            if (rect.right < columnRect.right - 90) continue
            if (!hasVisibleBackground(element)) continue
            candidates.push({ element, rect })
          } catch {}
        }
        // 只保留最内层的那个气泡，避免外层整行也被描边
        for (const candidate of candidates) {
          const nested = candidates.some((other) => other !== candidate && candidate.element.contains(other.element))
          if (!nested) paint(candidate.element, 'dwhd-neon-item')
        }
      }

      const refresh = () => {
        try { paint(findComposerCard(), 'dwhd-neon') } catch {}
        try { paint(findSidebar(), 'dwhd-neon') } catch {}
        try { scanSidebar() } catch {}
        try { scanIcons() } catch {}
        try { scanUserBubbles() } catch {}
      }
      refresh()
      const timer = window.setInterval(refresh, 800)
      return () => {
        window.clearInterval(timer)
        for (const [element, className] of painted) {
          try { element.classList.remove(className) } catch {}
        }
        painted.clear()
      }
    }

    /**
     * 直接接管挂件自己的泡泡（.dshwv-pop）：
     * - 强制打开泡泡，把原生内容隐藏，塞入我们的歌词节点；
     * - 用 MutationObserver + 定时器持续压住，顺便拦截每轮消耗泡泡的弹出；
     * - 结束时只移除自己加的类和节点，原生 DOM 引用和内容原样保留。
     */
    function createNativeBubbleInjector(widget) {
      const root = widget.root
      const pop = root.querySelector('.dshwv-pop')
      const textBox = pop ? pop.querySelector('.dshwv-text') : null
      if (!pop || !textBox) return null
      const wasOpen = pop.classList.contains('dshwv-pop-open')
      const lyric = document.createElement('div')
      lyric.className = 'dwhd-native-lyric'
      lyric.textContent = '♪'
      let observer = null
      const ensure = () => {
        if (!pop.isConnected || !textBox.isConnected) return
        if (!pop.classList.contains('dshwv-pop-open')) pop.classList.add('dshwv-pop-open')
        if (!pop.classList.contains('dwhd-native-mode')) pop.classList.add('dwhd-native-mode')
        if (!textBox.classList.contains('dwhd-lyric-mode')) textBox.classList.add('dwhd-lyric-mode')
        if (lyric.parentNode !== textBox) textBox.appendChild(lyric)
      }
      ensure()
      try {
        observer = new MutationObserver(() => { ensure() })
        observer.observe(pop, { attributes: true, attributeFilter: ['class'] })
        observer.observe(textBox, { childList: true })
      } catch {}
      const timer = window.setInterval(ensure, 650)
      return {
        setLine(text) {
          lyric.textContent = text || '♪'
          ensure()
        },
        restore() {
          try { observer?.disconnect() } catch {}
          window.clearInterval(timer)
          try { lyric.remove() } catch {}
          try { pop.classList.remove('dwhd-native-mode') } catch {}
          try { textBox.classList.remove('dwhd-lyric-mode') } catch {}
          try {
            if (wasOpen) pop.classList.add('dshwv-pop-open')
            else pop.classList.remove('dshwv-pop-open')
          } catch {}
        },
      }
    }

    /** 移动真实挂件：保存原内联位置与过渡，蹦迪结束后原样恢复。 */
    function createWidgetAnimator(widget) {
      const { root, img } = widget
      const savedRoot = {
        left: root.style.getPropertyValue('left'),
        leftPriority: root.style.getPropertyPriority('left'),
        top: root.style.getPropertyValue('top'),
        topPriority: root.style.getPropertyPriority('top'),
        right: root.style.getPropertyValue('right'),
        rightPriority: root.style.getPropertyPriority('right'),
        bottom: root.style.getPropertyValue('bottom'),
        bottomPriority: root.style.getPropertyPriority('bottom'),
        transition: root.style.getPropertyValue('transition'),
        transitionPriority: root.style.getPropertyPriority('transition'),
      }
      const saved = {
        transform: img.style.getPropertyValue('transform'),
        transformPriority: img.style.getPropertyPriority('transform'),
        transformOrigin: img.style.getPropertyValue('transform-origin'),
        transformOriginPriority: img.style.getPropertyPriority('transform-origin'),
        willChange: img.style.getPropertyValue('will-change'),
        willChangePriority: img.style.getPropertyPriority('will-change'),
      }
      const rootRect = root.getBoundingClientRect()
      const imageRectNow = img.getBoundingClientRect()
      const offsetX = imageRectNow.left - rootRect.left
      const offsetY = imageRectNow.top - rootRect.top
      root.classList.add('dwhd-dancing')
      root.style.setProperty('right', 'auto')
      root.style.setProperty('bottom', 'auto')
      root.style.setProperty('transition', 'none')
      img.style.setProperty('transform-origin', '50% 100%')
      img.style.setProperty('will-change', 'transform')
      const position = (imageLeft, imageTop) => ({
        left: Math.round(imageLeft - offsetX),
        top: Math.round(imageTop - offsetY),
      })
      const imageTransform = (lift, sx, sy, sway) =>
        `translate3d(${sway.toFixed(2)}px, ${(-lift).toFixed(2)}px, 0) scale(${sx.toFixed(3)}, ${sy.toFixed(3)}) rotate(${(sway * 0.55).toFixed(2)}deg)`
      let lastLeft = null
      let lastTop = null
      return {
        position,
        imageTransform,
        move(imageLeft, imageTop) {
          const next = position(imageLeft, imageTop)
          const left = next.left
          const top = next.top
          if (left !== lastLeft) {
            root.style.setProperty('left', left + 'px', 'important')
            lastLeft = left
          }
          if (top !== lastTop) {
            root.style.setProperty('top', top + 'px', 'important')
            lastTop = top
          }
        },
        apply(lift, sx, sy, sway) {
          img.style.setProperty('transform', imageTransform(lift, sx, sy, sway))
        },
        restore() {
          root.classList.remove('dwhd-dancing')
          const restoreRoot = (property, value, priority) => {
            if (value) root.style.setProperty(property, value, priority)
            else root.style.removeProperty(property)
          }
          restoreRoot('left', savedRoot.left, savedRoot.leftPriority)
          restoreRoot('top', savedRoot.top, savedRoot.topPriority)
          restoreRoot('right', savedRoot.right, savedRoot.rightPriority)
          restoreRoot('bottom', savedRoot.bottom, savedRoot.bottomPriority)
          restoreRoot('transition', savedRoot.transition, savedRoot.transitionPriority)
          const restore = (property, value, priority) => {
            if (value) img.style.setProperty(property, value, priority)
            else img.style.removeProperty(property)
          }
          restore('transform', saved.transform, saved.transformPriority)
          restore('transform-origin', saved.transformOrigin, saved.transformOriginPriority)
          restore('will-change', saved.willChange, saved.willChangePriority)
        },
      }
    }

    /** 窗口级轻微抖动：作用于应用根节点，结束时恢复。 */
    function createAppShaker() {
      const root = findAppRoot()
      if (!root) return { shake() {}, restore() {} }
      const savedTransform = root.style.getPropertyValue('transform')
      const savedTransformPriority = root.style.getPropertyPriority('transform')
      const savedTransition = root.style.getPropertyValue('transition')
      const savedTransitionPriority = root.style.getPropertyPriority('transition')
      root.style.setProperty('transition', 'none')
      root.style.setProperty('will-change', 'transform')
      return {
        shake(dx, dy, angle = 0, scale = 1) {
          root.style.setProperty(
            'transform',
            `translate3d(${dx.toFixed(2)}px,${dy.toFixed(2)}px,0) rotate(${angle.toFixed(2)}deg) scale(${scale.toFixed(4)})`,
          )
        },
        restore() {
          try {
            if (savedTransform) root.style.setProperty('transform', savedTransform, savedTransformPriority)
            else root.style.removeProperty('transform')
            if (savedTransition) root.style.setProperty('transition', savedTransition, savedTransitionPriority)
            else root.style.removeProperty('transition')
            root.style.removeProperty('will-change')
          } catch {}
        },
      }
    }

    /**
     * 预先准备分裂层的可视快照。
     * 只复制应用根节点，不复制 body；所有滚动容器在下一帧恢复，避免跳回会话开头。
     */
    function prepareSplitSnapshot() {
      const source = document.querySelector('#root') || document.body?.firstElementChild
      if (!source) return null
      const key = `dwhd-snapshot-${Math.random().toString(36).slice(2)}`
      const scrollables = []
      const controls = []
      const mark = (element) => {
        if (!element || element.nodeType !== 1) return
        const scrollable = element.scrollHeight > element.clientHeight + 2
          || element.scrollWidth > element.clientWidth + 2
        if (scrollable) {
          element.setAttribute('data-dwhd-snapshot-key', key)
          scrollables.push({ top: element.scrollTop, left: element.scrollLeft })
        }
        const tag = element.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          element.setAttribute('data-dwhd-control-key', key)
          controls.push({ value: element.value, checked: element.checked })
        }
      }
      mark(source)
      source.querySelectorAll('*').forEach(mark)
      const template = source.cloneNode(true)
      const clearMarks = (root) => {
        if (root.matches?.(`[data-dwhd-snapshot-key="${key}"]`)) root.removeAttribute('data-dwhd-snapshot-key')
        if (root.matches?.(`[data-dwhd-control-key="${key}"]`)) root.removeAttribute('data-dwhd-control-key')
        root.querySelectorAll(`[data-dwhd-snapshot-key="${key}"],[data-dwhd-control-key="${key}"]`).forEach((element) => {
          element.removeAttribute('data-dwhd-snapshot-key')
          element.removeAttribute('data-dwhd-control-key')
        })
      }
      clearMarks(source)
      const stripInteractive = (root) => {
        root.querySelectorAll('script').forEach((element) => element.remove())
      }
      stripInteractive(template)
      const pages = [template, template.cloneNode(true)]
      const restore = (clone) => {
        const clonedScrollables = []
        if (clone.matches?.(`[data-dwhd-snapshot-key="${key}"]`)) clonedScrollables.push(clone)
        clonedScrollables.push(...clone.querySelectorAll(`[data-dwhd-snapshot-key="${key}"]`))
        clonedScrollables.forEach((element, index) => {
          const state = scrollables[index]
          if (!state) return
          element.scrollTop = state.top
          element.scrollLeft = state.left
        })
        const clonedControls = []
        if (clone.matches?.(`[data-dwhd-control-key="${key}"]`)) clonedControls.push(clone)
        clonedControls.push(...clone.querySelectorAll(`[data-dwhd-control-key="${key}"]`))
        clonedControls.forEach((element, index) => {
          const state = controls[index]
          if (!state) return
          try {
            if ('value' in element) element.value = state.value
            if ('checked' in element) element.checked = state.checked
          } catch {}
        })
        clearMarks(clone)
      }
      return { template, pages, restore }
    }

    /**
     * 分裂转场：固定左右裁剪层，内部各自旋转；挂件和音响按实时运动公式同步到两侧。
     */
    function startSplitSpin({ snapshot, widget, speaker, getFrame, onDone }) {
      if (!snapshot) return () => {}
      const layer = document.createElement('div')
      layer.className = 'dwhd-split-layer'
      const makeSide = (sideName, direction) => {
        const side = document.createElement('div')
        side.className = `dwhd-split-side ${sideName}`
        const spin = document.createElement('div')
        spin.className = 'dwhd-split-spin'
        const page = snapshot.pages?.[sideName === 'left' ? 0 : 1] || snapshot.template.cloneNode(true)
        page.className = `${page.className || ''} dwhd-split-body`.trim()
        spin.appendChild(page)
        const widgetClone = widget?.root?.cloneNode(true)
        const speakerClone = speaker?.cloneNode(true)
        if (widgetClone) {
          widgetClone.classList.add('dwhd-split-widget')
          spin.appendChild(widgetClone)
        }
        if (speakerClone) {
          speakerClone.classList.add('dwhd-split-speaker')
          spin.appendChild(speakerClone)
        }
        side.appendChild(spin)
        return { side, spin, widgetClone, speakerClone, direction }
      }
      const left = makeSide('left', 1)
      const right = makeSide('right', -1)
      layer.appendChild(left.side)
      layer.appendChild(right.side)
      document.body.appendChild(layer)
      snapshot.restore(left.spin)
      snapshot.restore(right.spin)
      window.requestAnimationFrame(() => {
        if (!finished) {
          snapshot.restore(left.spin)
          snapshot.restore(right.spin)
        }
      })
      const applyFrame = (entry, frame) => {
        if (entry.widgetClone && frame.widget) {
          entry.widgetClone.style.setProperty('left', `${frame.widget.left}px`, 'important')
          entry.widgetClone.style.setProperty('top', `${frame.widget.top}px`, 'important')
          const image = entry.widgetClone.querySelector('.dshwv-img') || entry.widgetClone.querySelector('img')
          if (image) image.style.setProperty('transform', frame.widget.imageTransform)
        }
        if (entry.speakerClone && frame.speaker) {
          entry.speakerClone.style.setProperty('left', `${frame.speaker.left}px`, 'important')
          entry.speakerClone.style.setProperty('top', `${frame.speaker.top}px`, 'important')
          entry.speakerClone.style.setProperty('transform', frame.speaker.transform)
        }
      }
      const startedAt = performance.now()
      const duration = 3600
      let frameId = 0
      let finished = false
      const initialMotion = getFrame?.(0)
      if (initialMotion) {
        applyFrame(left, initialMotion)
        applyFrame(right, initialMotion)
      }
      const cleanup = () => {
        if (finished) return
        finished = true
        window.cancelAnimationFrame(frameId)
        try { layer.remove() } catch {}
        try { onDone?.() } catch {}
      }
      const step = () => {
        if (finished) return
        const now = performance.now()
        const progress = Math.min(1, (now - startedAt) / duration)
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2
        const angle = 360 * eased
        left.spin.style.transform = `rotate(${angle.toFixed(2)}deg)`
        right.spin.style.transform = `rotate(${(-angle).toFixed(2)}deg)`
        const motion = getFrame?.((now - startedAt) / 1000)
        if (motion) {
          applyFrame(left, motion)
          applyFrame(right, motion)
        }
        if (progress >= 1) {
          cleanup()
          return
        }
        frameId = window.requestAnimationFrame(step)
      }
      frameId = window.requestAnimationFrame(step)
      return cleanup
    }

    /** 极简合成节拍：没有可播放音频时的兜底。 */
    function createSynth() {
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (!Ctor) return null
      let ac
      try { ac = new Ctor() } catch { return null }
      const master = ac.createGain()
      master.gain.value = 0.2
      master.connect(ac.destination)
      const rate = 126 / 60
      let timer = null
      let nextBeat = ac.currentTime
      let beat = 0

      const kick = (at) => {
        const osc = ac.createOscillator()
        const gain = ac.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(150, at)
        osc.frequency.exponentialRampToValueAtTime(46, at + 0.17)
        gain.gain.setValueAtTime(0.9, at)
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.2)
        osc.connect(gain).connect(master)
        osc.start(at)
        osc.stop(at + 0.22)
      }
      const hat = (at) => {
        const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * 0.05), ac.sampleRate)
        const data = buffer.getChannelData(0)
        for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1
        const source = ac.createBufferSource()
        source.buffer = buffer
        const filter = ac.createBiquadFilter()
        filter.type = 'highpass'
        filter.frequency.value = 7200
        const gain = ac.createGain()
        gain.gain.setValueAtTime(0.16, at)
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.05)
        source.connect(filter).connect(gain).connect(master)
        source.start(at)
      }
      const tick = () => {
        const horizon = ac.currentTime + 0.28
        while (nextBeat < horizon) {
          if (beat % 2 === 0) kick(nextBeat)
          hat(nextBeat + 0.5 / rate)
          nextBeat += 1 / rate
          beat += 1
        }
      }
      tick()
      timer = window.setInterval(tick, 120)
      try { ac.resume().catch(() => {}) } catch {}
      return {
        energy(time) {
          return Math.pow(Math.max(0, Math.sin(time * Math.PI * rate)), 4)
        },
        resume() { try { ac.resume().catch(() => {}) } catch {} },
        stop() {
          if (timer !== null) window.clearInterval(timer)
          timer = null
          try { ac.close().catch(() => {}) } catch {}
        },
      }
    }

    function discoBallSvg() {
      const latitudes = [[28, 3], [38, 2.5], [48, 2], [60, 2.5], [72, 3]]
      const longitudes = [10, 24, 38]
      return h('svg', {
        viewBox: '0 0 100 100',
        width: '100%',
        height: '100%',
        'aria-hidden': true,
      },
        h('defs', null,
          h('radialGradient', { id: 'dwhd-ball-base', cx: '34%', cy: '28%', r: '78%' },
            h('stop', { offset: '0%', stopColor: '#ffffff' }),
            h('stop', { offset: '26%', stopColor: '#d7efff' }),
            h('stop', { offset: '56%', stopColor: '#7fb0ec' }),
            h('stop', { offset: '80%', stopColor: '#334c94' }),
            h('stop', { offset: '100%', stopColor: '#111a3d' }),
          ),
          h('pattern', { id: 'dwhd-ball-facets', width: '9', height: '9', patternUnits: 'userSpaceOnUse' },
            h('rect', { width: 9, height: 9, fill: '#6f9ee0' }),
            h('rect', { x: 1, y: 1, width: 7, height: 7, fill: '#d9efff', opacity: 0.92 }),
            h('rect', { x: 1, y: 1, width: 3.4, height: 3.4, fill: '#ffffff', opacity: 0.55 }),
            h('rect', { x: 5.6, y: 5.6, width: 2.4, height: 2.4, fill: '#2e4c94', opacity: 0.35 }),
          ),
          h('clipPath', { id: 'dwhd-ball-clip' },
            h('circle', { cx: 50, cy: 50, r: 46 }),
          ),
          h('linearGradient', { id: 'dwhd-ball-sheen', x1: '0', y1: '0', x2: '1', y2: '1' },
            h('stop', { offset: '0', stopColor: '#ffffff', stopOpacity: 0.62 }),
            h('stop', { offset: '0.42', stopColor: '#ffffff', stopOpacity: 0 }),
            h('stop', { offset: '1', stopColor: '#ffffff', stopOpacity: 0.24 }),
          ),
        ),
        h('circle', { cx: 50, cy: 50, r: 46, fill: 'url(#dwhd-ball-base)' }),
        h('g', { clipPath: 'url(#dwhd-ball-clip)' },
          h('rect', { x: 4, y: 4, width: 92, height: 92, fill: 'url(#dwhd-ball-facets)' }),
          ...latitudes.map(([cy, ry]) => {
            const dx = Math.abs(cy - 50)
            const rx = Math.sqrt(Math.max(0, 46 * 46 - dx * dx))
            return h('ellipse', {
              key: 'lat-' + cy,
              cx: 50,
              cy,
              rx,
              ry,
              fill: 'none',
              stroke: 'rgba(20,32,72,.5)',
              strokeWidth: 0.8,
            })
          }),
          ...longitudes.map((rx) => h('ellipse', {
            key: 'lon-' + rx,
            cx: 50,
            cy: 50,
            rx,
            ry: 46,
            fill: 'none',
            stroke: 'rgba(255,255,255,.32)',
            strokeWidth: 0.8,
          })),
          h('rect', { x: 4, y: 4, width: 92, height: 92, fill: 'url(#dwhd-ball-sheen)' }),
          h('ellipse', {
            cx: 37,
            cy: 30,
            rx: 15,
            ry: 9,
            fill: '#ffffff',
            opacity: 0.52,
            transform: 'rotate(-28 37 30)',
          }),
        ),
        h('circle', { cx: 50, cy: 50, r: 46, fill: 'none', stroke: '#e3f6ff', strokeOpacity: 0.85, strokeWidth: 1.2 }),
      )
    }

    function speakerSvg(width, height) {
      return h('svg', {
        width,
        height,
        viewBox: '0 0 100 140',
        preserveAspectRatio: 'xMidYMid meet',
        'aria-hidden': true,
      },
        h('rect', { x: 8, y: 6, width: 84, height: 128, rx: 12, fill: '#20243f', stroke: '#7b8ed0', strokeWidth: 2 }),
        h('rect', { x: 14, y: 12, width: 72, height: 116, rx: 9, fill: '#141832' }),
        h('circle', { cx: 50, cy: 42, r: 25, fill: '#252b50', stroke: '#8aa2e8', strokeWidth: 2 }),
        h('circle', { className: 'dwhd-cone-driver', cx: 50, cy: 42, r: 18, fill: '#7fd4ff', opacity: 0.94 }),
        h('circle', { cx: 50, cy: 42, r: 7, fill: '#eaf7ff' }),
        h('circle', { cx: 50, cy: 101, r: 17, fill: '#252b50', stroke: '#8aa2e8', strokeWidth: 2 }),
        h('circle', { className: 'dwhd-cone-driver dwhd-cone-driver2', cx: 50, cy: 101, r: 11, fill: '#ff9ed8', opacity: 0.9 }),
        h('rect', { x: 34, y: 61, width: 32, height: 5, rx: 2, fill: '#56669c' }),
        h('rect', { x: 34, y: 128, width: 8, height: 8, rx: 2, fill: '#7b8ed0' }),
        h('rect', { x: 58, y: 128, width: 8, height: 8, rx: 2, fill: '#7b8ed0' }),
      )
    }

    function DanceOverlay(props) {
      const t = props.t || ((key) => DICT.zh[key] || key)
      const [dance, setDance] = React.useState(null)
      const [active, setActive] = React.useState(false)
      const [needsTap, setNeedsTap] = React.useState(false)
      const [widgetReady, setWidgetReady] = React.useState(false)
      const [nativeLyric, setNativeLyric] = React.useState(false)
      const [keyLine, setKeyLine] = React.useState('')
      const [progress, setProgress] = React.useState(0)
      const [speakerSize, setSpeakerSize] = React.useState({ width: 60, height: 100 })
      const [volume, setVolume] = React.useState(loadVolume)
      const [hintAnchor, setHintAnchor] = React.useState({ top: 96, right: 18 })
      const [neonRects, setNeonRects] = React.useState(null)
      const [showPrereq, setShowPrereq] = React.useState(false)
      const [prereqDismissed, setPrereqDismissed] = React.useState(false)

      const stageRef = React.useRef(null)
      const orbRef = React.useRef(null)
      const ballPulseRef = React.useRef(null)
      const speakerRef = React.useRef(null)
      const bubbleRef = React.useRef(null)
      const hintRef = React.useRef(null)
      const audioRef = React.useRef(null)
      const synthRef = React.useRef(null)
      const audioContextRef = React.useRef(null)
      const sharedAudioRef = React.useRef(null)
      const sharedContextRef = React.useRef(null)
      const sharedAnalyserRef = React.useRef(null)
      const sharedFrequencyRef = React.useRef(null)
      const sharedSourceRef = React.useRef(false)
      const stopRef = React.useRef(null)
      const lastVersionRef = React.useRef(-1)
      const activeRef = React.useRef(false)
      const progressRef = React.useRef(-1)
      const volumeRef = React.useRef(volume)
      // 动画循环写入：转场进行中 / 当前抖动强度。测量提示条位置时要避开它们，
      // 否则 body 被旋转、位移后 getBoundingClientRect() 会不断变化，提示条就会乱跑。
      const motionRef = React.useRef({ busy: false, shake: 0 })

      React.useEffect(() => { activeRef.current = active }, [active])
      React.useEffect(() => {
        volumeRef.current = volume
        if (audioRef.current) {
          try { audioRef.current.volume = volume } catch {}
        }
      }, [volume])

      // 提示条位置：贴着会话内容区顶边，窗口缩放/最大化后重新测量。
      // 整页旋转/分裂转场、以及每拍窗口抖动期间跳过测量：那时 body 带 transform，
      // 量出来的坐标是歪的，会导致音量条来回跳。
      React.useEffect(() => {
        if (!active) return
        let disposed = false
        const measure = () => {
          if (disposed) return
          const motion = motionRef.current
          if (motion.busy || motion.shake > 0.08) return
          let anchor = { top: 96, right: 18 }
          try { anchor = measureHintAnchor() } catch {}
          setHintAnchor((previous) => {
            // 1px 级差异不重排，避免亚像素抖动引起视觉跳动。
            if (Math.abs(previous.top - anchor.top) < 2 && Math.abs(previous.right - anchor.right) < 2) {
              return previous
            }
            return anchor
          })
          // 顺手复核霓虹描边：侧栏折叠/宽度变化时也能跟上，不必等窗口 resize。
          try {
            const nextNeon = measureNeonRects()
            if (nextNeon) {
              setNeonRects((previous) => {
                if (previous && rectsClose(previous.composer, nextNeon.composer)
                  && rectsClose(previous.sidebar, nextNeon.sidebar)) {
                  return previous
                }
                return nextNeon
              })
            }
          } catch {}
        }
        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        const timer = window.setInterval(measure, 400)
        return () => {
          disposed = true
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
          window.clearInterval(timer)
        }
      }, [active])

      // 整场蹦迪共用一个 audio 元素和 AudioContext：
      // 切歌时只换 src，不重建元素/上下文，避免第二首被自动播放策略静音。
      React.useEffect(() => {
        const audio = new Audio()
        audio.preload = 'auto'
        audio.volume = volumeRef.current
        sharedAudioRef.current = audio
        return () => {
          try {
            audio.pause()
            audio.removeAttribute('src')
            audio.load()
          } catch {}
          try { sharedContextRef.current?.close() } catch {}
          sharedAudioRef.current = null
          sharedContextRef.current = null
          sharedAnalyserRef.current = null
          sharedFrequencyRef.current = null
          sharedSourceRef.current = false
        }
      }, [])

      // 前置挂件检测：8 秒内没出现就提示安装。
      React.useEffect(() => {
        let disposed = false
        let timer = null
        let tries = 0
        const tick = () => {
          if (disposed) return
          if (findWidget()) {
            setWidgetReady(true)
            setShowPrereq(false)
            return
          }
          tries += 1
          if (tries >= 16) {
            setShowPrereq(true)
            return
          }
          timer = window.setTimeout(tick, 500)
        }
        tick()
        return () => {
          disposed = true
          if (timer !== null) window.clearTimeout(timer)
        }
      }, [])

      // 轮询宿主状态
      React.useEffect(() => {
        let disposed = false
        let timer = null
        const tick = async () => {
          try {
            const response = await fetch(STATE_URL, { cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (disposed) return
            const version = Number(data.version) || 0
            if (version !== lastVersionRef.current) {
              lastVersionRef.current = version
              if (data.status === 'playing') {
                setDance(data)
              } else {
                setDance(null)
                if (activeRef.current && stopRef.current) stopRef.current(false)
              }
            }
          } catch {}
          if (!disposed) timer = window.setTimeout(tick, POLL_MS)
        }
        tick()
        return () => {
          disposed = true
          if (timer !== null) window.clearTimeout(timer)
        }
      }, [])

      // 一首歌的生命周期
      React.useEffect(() => {
        if (!dance || dance.status !== 'playing') return
        const widget = findWidget()
        setWidgetReady(Boolean(widget))
        const nativeBubble = widget ? createNativeBubbleInjector(widget) : null
        setNativeLyric(Boolean(nativeBubble))
        setActive(true)
        setNeedsTap(false)
        setKeyLine('')
        setProgress(0)
        progressRef.current = -1

        const imageRect = widget ? widget.img.getBoundingClientRect() : null
        let imgWidth = widget ? Math.min(360, Math.max(40, Math.round(imageRect.width))) : 0
        let imgHeight = widget ? Math.min(360, Math.max(40, Math.round(imageRect.height))) : 0
        let speakerHeight = widget ? Math.max(56, Math.round(imgHeight * 0.62)) : 0
        let speakerWidth = widget ? Math.max(40, Math.round(speakerHeight * (100 / 140))) : 0
        const gap = 6
        // 挂件自身离窗口底边的距离：窗口缩放后据此重新推导纵向落点，保持贴边。
        const bottomGap = widget && imageRect ? Math.max(0, Math.round(window.innerHeight - imageRect.top - imgHeight)) : 0
        setSpeakerSize({ width: speakerWidth, height: speakerHeight })
        const keyLines = Array.isArray(dance.keyLyrics) ? dance.keyLyrics : []

        const animator = widget ? createWidgetAnimator(widget) : null
        const shaker = createAppShaker()
        const neonOff = applyNeon()
        setNeonRects(measureNeonRects())
        let viewportWidth = window.innerWidth
        let viewportHeight = window.innerHeight
        let minImageX = 20 + speakerWidth + gap
        let maxImageX = Math.max(minImageX, viewportWidth - imgWidth - 20)
        const startImageX = widget && imageRect ? imageRect.left : maxImageX
        let travelMid = (minImageX + maxImageX) / 2
        let travelAmp = Math.max(0, (maxImageX - minImageX) / 2)
        const travelStart = Math.max(minImageX, Math.min(maxImageX, startImageX))
        let travelPhase = travelAmp > 4
          ? Math.acos(Math.max(-1, Math.min(1, (travelStart - travelMid) / travelAmp)))
          : 0
        const travelPeriod = 12
        let anchorY = widget
          ? Math.max(40, Math.min(viewportHeight - imgHeight - 20, imageRect.top))
          : 0

        let disposed = false
        let raf = 0
        let audio = sharedAudioRef.current
        let analyser = null
        let frequency = null
        let synth = null
        let energy = 0
        let keyTimer = null
        let keyIndex = -1

        // Q 弹物理量：lift（向上位移）、liftV（速度）、squash（着地压缩）、beatEnv（窗口抖动）
        let lift = 0
        let liftV = 0
        let squash = 0
        let shakeEnv = 0
        let beatCount = 0
        let lastBeatAt = -1
        let bassAvg = 0
        let prevBass = 0
        let lastFrameAt = performance.now()
        let moveElapsed = 0
        // 每 12 拍里随机挑一拍：三种转场随机
        let spinActive = false
        let spinStartedAt = 0
        let spinDirection = 1
        let spinTurns = 720
        let spinDuration = 1800
        let splitActive = false
        let splitCleanup = null
        let splitSnapshot = null
        let splitSnapshotTimer = null
        let splitSnapshotCancel = null
        // 快照一旦过期（聊天框长高、发了图片、侧栏改动等）就不能再用来演分裂，
        // 否则第一次分裂会显示旧样式，也就是「穿帮」。
        let snapshotDirty = true
        let snapshotDirtyTimer = null
        let latestMotionFrame = null
        let nextSpinBeat = 1 + Math.floor(Math.random() * 11)
        const prepareSnapshot = () => {
          if (disposed || splitActive) return
          try {
            splitSnapshot = prepareSplitSnapshot()
            snapshotDirty = false
          } catch {
            splitSnapshot = null
            snapshotDirty = true
          }
        }
        const scheduleSnapshot = (delay = 0) => {
          if (disposed) return
          if (splitSnapshotCancel) {
            try { splitSnapshotCancel() } catch {}
            splitSnapshotCancel = null
          }
          if (delay > 0) {
            splitSnapshotTimer = window.setTimeout(prepareSnapshot, delay)
            splitSnapshotCancel = () => window.clearTimeout(splitSnapshotTimer)
          } else if (typeof window.requestIdleCallback === 'function') {
            splitSnapshotTimer = window.requestIdleCallback(prepareSnapshot, { timeout: 900 })
            splitSnapshotCancel = () => window.cancelIdleCallback(splitSnapshotTimer)
          } else {
            splitSnapshotTimer = window.setTimeout(prepareSnapshot, 320)
            splitSnapshotCancel = () => window.clearTimeout(splitSnapshotTimer)
          }
        }
        /** 标记快照过期，并在稍后空闲时重建（合并高频 DOM 变化）。 */
        const markSnapshotDirty = () => {
          if (disposed) return
          snapshotDirty = true
          if (snapshotDirtyTimer !== null) window.clearTimeout(snapshotDirtyTimer)
          snapshotDirtyTimer = window.setTimeout(() => {
            snapshotDirtyTimer = null
            if (!disposed && snapshotDirty && !splitActive) scheduleSnapshot(0)
          }, 600)
        }
        scheduleSnapshot()

        // 监听界面结构/尺寸变化：聊天框多行文本、插图、侧栏展开折叠都会让快照过期。
        let snapshotObservers = []
        try {
          const root = document.querySelector('#root') || document.body
          const stage = stageRef.current
          const observers = []
          const observedTargets = new Set()
          const observeResize = (target) => {
            if (!target || typeof ResizeObserver !== 'function') return
            if (observedTargets.has(target)) return
            observedTargets.add(target)
            const observer = new ResizeObserver(() => { markSnapshotDirty() })
            observer.observe(target)
            observers.push(observer)
          }
          observeResize(findComposerCard())
          observeResize(findSidebar())
          observeResize(findConversationColumn())
          // 容器可能比蹦迪晚出现，补挂一次。
          window.setTimeout(() => {
            if (disposed) return
            observeResize(findComposerCard())
            observeResize(findSidebar())
            observeResize(findConversationColumn())
          }, 1500)
          if (typeof MutationObserver === 'function') {
            const observer = new MutationObserver((records) => {
              for (const record of records) {
                // 忽略我们自己舞台里的变化，否则每帧都会判定为脏。
                if (stage && record.target && stage.contains(record.target)) continue
                markSnapshotDirty()
                return
              }
            })
            observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true })
            observers.push(observer)
          }
          snapshotObservers = observers
        } catch {}

        /**
         * 窗口尺寸变化后重新测量：挂件尺寸、活动范围、纵向落点、霓虹光条。
         * 不重测量就会出现「放大窗口后光条/挂件错位」。转场进行中不测量，
         * 因为那时 body 带旋转，量出来是歪的。
         */
        const remodel = () => {
          if (disposed || splitActive || spinActive) return
          // 抖动期间 body 被位移，量出来的坐标会偏；等这一拍过去再量。
          if (shakeEnv > 0.08) return
          if (widget) {
            try {
              const live = findWidget()
              if (live) {
                // 用布局尺寸而不是 getBoundingClientRect：后者会被我们自己的缩放变形影响。
                const width = live.img.offsetWidth || 0
                const height = live.img.offsetHeight || 0
                if (width > 20 && height > 20) {
                  imgWidth = Math.min(360, Math.max(40, Math.round(width)))
                  imgHeight = Math.min(360, Math.max(40, Math.round(height)))
                  speakerHeight = Math.max(56, Math.round(imgHeight * 0.62))
                  speakerWidth = Math.max(40, Math.round(speakerHeight * (100 / 140)))
                  setSpeakerSize({ width: speakerWidth, height: speakerHeight })
                }
              }
            } catch {}
          }
          viewportWidth = window.innerWidth
          viewportHeight = window.innerHeight
          const previousX = travelMid + travelAmp * Math.cos(travelPhase + (moveElapsed / travelPeriod) * Math.PI * 2)
          minImageX = 20 + speakerWidth + gap
          maxImageX = Math.max(minImageX, viewportWidth - imgWidth - 20)
          travelMid = (minImageX + maxImageX) / 2
          travelAmp = Math.max(0, (maxImageX - minImageX) / 2)
          const clampedX = Math.max(minImageX, Math.min(maxImageX, previousX))
          // 用当前横坐标反推相位，保证缩放窗口时挂件不会瞬移到别处。
          travelPhase = travelAmp > 4
            ? Math.acos(Math.max(-1, Math.min(1, (clampedX - travelMid) / travelAmp)))
            : 0
          if (widget) {
            const naturalY = viewportHeight - imgHeight - bottomGap
            anchorY = Math.max(24, Math.min(Math.max(24, viewportHeight - imgHeight - 12), naturalY))
          }
          setNeonRects(measureNeonRects())
        }
        let remodelQueued = false
        const queueRemodel = () => {
          if (disposed || remodelQueued) return
          remodelQueued = true
          window.requestAnimationFrame(() => {
            remodelQueued = false
            remodel()
          })
        }
        window.addEventListener('resize', queueRemodel)

        const cycleKeyLine = () => {
          if (splitActive || keyLines.length === 0) return
          keyIndex = (keyIndex + 1) % keyLines.length
          const text = String(keyLines[keyIndex])
          if (nativeBubble) nativeBubble.setLine(text)
          else setKeyLine(text)
        }

        const updateProgress = () => {
          if (!audio) return
          const duration = audio.duration && Number.isFinite(audio.duration)
            ? audio.duration
            : (dance.durationSec || 0)
          if (duration > 0) {
            const percent = Math.floor((audio.currentTime / duration) * 100)
            if (percent !== progressRef.current) {
              progressRef.current = percent
              setProgress(percent / 100)
            }
          }
        }

        const attachAnalyser = async () => {
          if (disposed || !audio) return
          const Ctor = window.AudioContext || window.webkitAudioContext
          if (!Ctor) return
          try {
            let context = sharedContextRef.current
            if (!context) {
              context = new Ctor()
              sharedContextRef.current = context
              const nextAnalyser = context.createAnalyser()
              nextAnalyser.fftSize = 256
              nextAnalyser.smoothingTimeConstant = 0.75
              sharedAnalyserRef.current = nextAnalyser
              sharedFrequencyRef.current = new Uint8Array(nextAnalyser.frequencyBinCount)
            }
            audioContextRef.current = context
            await context.resume()
            if (disposed) return
            if (context.state !== 'running') return
            if (!sharedSourceRef.current) {
              const source = context.createMediaElementSource(audio)
              source.connect(sharedAnalyserRef.current)
              sharedAnalyserRef.current.connect(context.destination)
              sharedSourceRef.current = true
            }
            analyser = sharedAnalyserRef.current
            frequency = sharedFrequencyRef.current
          } catch {
            analyser = null
          }
        }

        let detachAudio = null
        if (!audio) {
          try {
            audio = new Audio()
            audio.preload = 'auto'
            audio.volume = volumeRef.current
            sharedAudioRef.current = audio
          } catch {
            audio = null
          }
        }

        if (audio && dance.audioUrl) {
          try {
            let usedFallback = false
            const onTime = () => updateProgress()
            const onEnded = () => { if (!disposed) stop(true) }
            const onError = () => {
              if (disposed) return
              if (!usedFallback && typeof dance.fallbackUrl === 'string' && dance.fallbackUrl.length > 0) {
                usedFallback = true
                try {
                  audio.src = dance.fallbackUrl
                  audio.load()
                  const retry = audio.play()
                  if (retry && typeof retry.catch === 'function') retry.catch(() => { if (!disposed) setNeedsTap(true) })
                  return
                } catch {}
              }
              setNeedsTap(true)
            }
            detachAudio = () => {
              try {
                audio.removeEventListener('timeupdate', onTime)
                audio.removeEventListener('ended', onEnded)
                audio.removeEventListener('error', onError)
              } catch {}
            }
            audio.addEventListener('timeupdate', onTime)
            audio.addEventListener('ended', onEnded)
            audio.addEventListener('error', onError)
            audio.src = dance.audioUrl
            audio.load()
            audioRef.current = audio
            const playing = audio.play()
            if (playing && typeof playing.catch === 'function') {
              playing.catch(() => { if (!disposed) setNeedsTap(true) })
            }
            attachAnalyser()
          } catch {
            audio = null
          }
        } else if (audio) {
          try {
            audio.pause()
            audio.removeAttribute('src')
            audio.load()
          } catch {}
          audioRef.current = null
          setNeedsTap(true)
        } else {
          setNeedsTap(true)
        }

        if (!audio || !dance.audioUrl) {
          synth = createSynth()
          synthRef.current = synth
        }

        if (keyLines.length > 0) {
          window.setTimeout(() => { if (!disposed) cycleKeyLine() }, KEY_DELAY_MS)
          keyTimer = window.setInterval(() => { if (!disposed) cycleKeyLine() }, KEY_MS)
        }

        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
        const startedAt = performance.now()

        const triggerBeat = (nowSec) => {
          lastBeatAt = nowSec
          beatCount += 1
          shakeEnv = 1
          liftV += reducedMotion ? 90 : 240
          squash = Math.min(0.22, squash + 0.16)
        }

        const loop = () => {
          if (disposed) return
          const nowMs = performance.now()
          const elapsed = (nowMs - startedAt) / 1000
          const nowSec = nowMs / 1000
          const dt = Math.min(0.05, Math.max(0.001, (nowMs - lastFrameAt) / 1000))
          lastFrameAt = nowMs

          let next = 0
          let bass = 0
          if (analyser && frequency) {
            analyser.getByteFrequencyData(frequency)
            let sum = 0
            for (let index = 2; index < 14 && index < frequency.length; index += 1) sum += frequency[index]
            bass = Math.min(1, (sum / (12 * 255)) * 1.7)
            next = bass
          } else if (synth) {
            next = synth.energy(elapsed)
            bass = next
          } else {
            next = Math.pow(Math.max(0, Math.sin(elapsed * Math.PI * 2.05)), 4) * 0.9
            bass = next
          }
          energy = energy * 0.6 + next * 0.4
          const stage = stageRef.current
          if (stage) {
            stage.style.setProperty('--dwhd-energy', energy.toFixed(3))
          }

          // 节拍检测：有低频起音时按起音，否则用 128BPM 左右的兜底节拍。
          const sinceLastBeat = lastBeatAt < 0 ? 999 : nowSec - lastBeatAt
          const fallbackGap = analyser ? 0.55 : 0.47
          let detected = false
          if (analyser) {
            const rise = bass - bassAvg
            const jump = bass - prevBass
            prevBass = bass
            bassAvg = bassAvg * 0.95 + bass * 0.05
            if (bass > 0.12 && (rise > 0.05 || jump > 0.1) && sinceLastBeat > 0.26) detected = true
          }
          if (detected || sinceLastBeat > (reducedMotion ? fallbackGap * 2 : fallbackGap)) {
            triggerBeat(nowSec)
            if (beatCount >= nextSpinBeat) {
              if (!spinActive && !splitActive) {
                const variant = Math.floor(Math.random() * 3)
                if (variant === 2 && splitSnapshot && !snapshotDirty && !reducedMotion) {
                  shaker.shake(0, 0, 0, 1)
                  splitActive = true
                  splitCleanup = startSplitSpin({
                    snapshot: splitSnapshot,
                    widget,
                    speaker: speakerRef.current,
                    getFrame: () => latestMotionFrame,
                    onDone: () => {
                      splitActive = false
                      splitCleanup = null
                      splitSnapshot = null
                      snapshotDirty = true
                      if (!disposed) scheduleSnapshot(180)
                    },
                  })
                } else {
                  spinActive = true
                  spinStartedAt = nowMs
                  spinDirection = Math.random() < 0.5 ? -1 : 1
                  spinTurns = variant === 0 ? 720 : 360
                  spinDuration = variant === 0 ? 1800 : 3600
                }
              }
              nextSpinBeat = (Math.floor(beatCount / 12) + 1) * 12 + 1 + Math.floor(Math.random() * 11)
            }
          }

          let spinAngle = 0
          let spinScale = 1
          if (spinActive && !reducedMotion) {
            const progress = Math.min(1, (nowMs - spinStartedAt) / spinDuration)
            const eased = progress < 0.5
              ? 4 * progress * progress * progress
              : 1 - Math.pow(-2 * progress + 2, 3) / 2
            spinAngle = spinDirection * spinTurns * eased
            spinScale = 1 - 0.12 * Math.sin(Math.PI * progress)
            if (progress >= 1) spinActive = false
          }

          // 弹簧：每拍向上给一个冲量，落地时压扁、上升时拉长。
          liftV += (-180 * lift - 9 * liftV) * dt
          lift += liftV * dt
          if (lift < -12) {
            lift = -12
            if (liftV < 0) liftV = 0
          }
          if (lift > 80) {
            lift = 80
            if (liftV > 0) liftV = 0
          }
          squash *= Math.exp(-dt * 13)
          if (ballPulseRef.current) {
            ballPulseRef.current.style.transform = `scale(${(1 + energy * 0.16 + squash * 0.12).toFixed(3)})`
          }
          const stretch = Math.max(-0.14, Math.min(0.2, lift / 90))
          const sy = 1 + stretch - squash
          const sx = 1 - stretch * 0.8 + squash * 0.65
          const sway = reducedMotion ? 0 : Math.sin(nowSec * 4.2) * 0.8 * Math.min(1, energy)
          if (animator) {
            moveElapsed += dt
            const x = travelMid + travelAmp * Math.cos(travelPhase + (moveElapsed / travelPeriod) * Math.PI * 2)
            const rootPosition = animator.position(x, anchorY)
            latestMotionFrame = {
              widget: {
                left: rootPosition.left,
                top: rootPosition.top,
                imageTransform: animator.imageTransform(lift, sx, sy, sway),
              },
              speaker: {
                left: x - speakerWidth - gap,
                top: anchorY + imgHeight - speakerHeight - lift,
                transform: `scale(${(1 + energy * 0.05 + squash * 0.22).toFixed(3)})`,
              },
            }
            animator.move(x, anchorY)
            animator.apply(lift, sx, sy, sway)
            if (widget) {
              if (speakerRef.current) {
                speakerRef.current.style.left = `${(x - speakerWidth - gap).toFixed(1)}px`
                speakerRef.current.style.top = `${(anchorY + imgHeight - speakerHeight - lift).toFixed(1)}px`
                speakerRef.current.style.transform = `scale(${(1 + energy * 0.05 + squash * 0.22).toFixed(3)})`
                speakerRef.current.style.opacity = '1'
              }
              if (!nativeBubble && bubbleRef.current) {
                let left = x - 12
                let top = anchorY - 98 - lift - imgHeight * Math.max(0, stretch)
                left = Math.max(10, Math.min(viewportWidth - 296, left))
                top = Math.max(8, top)
                bubbleRef.current.style.left = `${left.toFixed(1)}px`
                bubbleRef.current.style.top = `${top.toFixed(1)}px`
                bubbleRef.current.style.transform = `rotate(${(sway * 0.6).toFixed(2)}deg)`
                bubbleRef.current.style.opacity = '1'
              }
            }
          }

          // 窗口抖动：每拍一次短促的垂直衰减脉冲；左右分裂期间只锁住页面抖动，挂件仍按物理轨迹运动
          shakeEnv *= Math.exp(-dt * 8.5)
          const dx = 0
          const dy = -6 * shakeEnv
          if (splitActive) shaker.shake(0, 0, 0, 1)
          else shaker.shake(reducedMotion ? 0 : dx, reducedMotion ? 0 : dy, reducedMotion ? 0 : spinAngle, spinScale)
          if (orbRef.current) {
            orbRef.current.style.transform = `translateX(-50%) translate3d(0px,${(dy * 1.3).toFixed(2)}px,0)`
          }
          if (stage) stage.style.setProperty('--dwhd-beat', shakeEnv.toFixed(3))

          if (!audio && synth) {
            const percent = Math.floor(((elapsed % 180) / 180) * 100)
            if (percent !== progressRef.current) {
              progressRef.current = percent
              setProgress(percent / 100)
            }
          }
          // 把当前是否在转场、以及抖动强度告诉测量逻辑：转场期间 body 带旋转，
          // 不能在这时候重新测量提示条位置，否则它会被测到别的地方。
          motionRef.current.busy = spinActive || splitActive
          motionRef.current.shake = shakeEnv
          // 窗口尺寸变了（拖拽/最大化/还原）就重新测量一次，光条与活动范围跟着对齐。
          if (!spinActive && !splitActive
            && (window.innerWidth !== viewportWidth || window.innerHeight !== viewportHeight)) {
            remodel()
          }
          raf = window.requestAnimationFrame(loop)
        }
        raf = window.requestAnimationFrame(loop)

        const stop = (notifyHost, keepAudio = false) => {
          if (disposed) return
          disposed = true
          window.cancelAnimationFrame(raf)
          if (keyTimer !== null) window.clearInterval(keyTimer)
          keyTimer = null
          if (nativeBubble) nativeBubble.restore()
          if (splitCleanup) {
            try { splitCleanup() } catch {}
            splitCleanup = null
            splitActive = false
          }
          if (splitSnapshotCancel) {
            try { splitSnapshotCancel() } catch {}
            splitSnapshotCancel = null
          }
          if (snapshotDirtyTimer !== null) {
            window.clearTimeout(snapshotDirtyTimer)
            snapshotDirtyTimer = null
          }
          for (const observer of snapshotObservers) {
            try { observer.disconnect() } catch {}
          }
          snapshotObservers = []
          splitSnapshot = null
          if (detachAudio) {
            try { detachAudio() } catch {}
            detachAudio = null
          }
          if (audio && !keepAudio) {
            try { audio.pause() } catch {}
          }
          if (synth) {
            try { synth.stop() } catch {}
            synth = null
          }
          if (animator) animator.restore()
          try { neonOff() } catch {}
          shaker.restore()
          motionRef.current.busy = false
          motionRef.current.shake = 0
          if (notifyHost) {
            try { fetch(STOP_URL, { method: 'POST' }).catch(() => {}) } catch {}
          }
          setActive(false)
          setNeedsTap(false)
          setKeyLine('')
          setNeonRects(null)
          audioRef.current = keepAudio ? audio : null
          synthRef.current = null
        }
        stopRef.current = stop

        const onKey = (event) => {
          if (event.key !== 'Escape' && event.key !== 'Esc') return
          event.preventDefault()
          event.stopPropagation()
          stop(true)
        }
        const onPageHide = () => {
          if (disposed) return
          try { fetch(STOP_URL, { method: 'POST', keepalive: true }).catch(() => {}) } catch {}
        }
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('pagehide', onPageHide)

        return () => {
          window.removeEventListener('keydown', onKey, true)
          window.removeEventListener('pagehide', onPageHide)
          window.removeEventListener('resize', queueRemodel)
          stop(false, true)
          stopRef.current = null
        }
      }, [dance && dance.version])

      /** 音量：同时改状态、当前播放器与本地持久化。 */
      const applyVolume = (raw) => {
        const next = Math.min(1, Math.max(0, Number(raw) / 100))
        if (!Number.isFinite(next)) return
        volumeRef.current = next
        setVolume(next)
        saveVolume(next)
        for (const element of [audioRef.current, sharedAudioRef.current]) {
          if (!element) continue
          try { element.volume = next } catch {}
        }
      }

      const tapToPlay = () => {
        setNeedsTap(false)
        if (audioRef.current) {
          try {
            const attempt = audioRef.current.play()
            if (attempt && typeof attempt.catch === 'function') attempt.catch(() => setNeedsTap(true))
          } catch {
            setNeedsTap(true)
          }
        }
        if (synthRef.current) {
          try { synthRef.current.resume() } catch {}
        }
        if (audioContextRef.current) {
          try { audioContextRef.current.resume().catch(() => {}) } catch {}
        }
      }

      if (!active || !dance) {
        const banner = showPrereq && !prereqDismissed
          ? h('div', { className: 'dwhd-prereq', role: 'alert' },
              h('h3', null, t('prereqTitle')),
              h('p', null, t('prereqBody')),
              h('button', {
                type: 'button',
                onClick: () => setPrereqDismissed(true),
              }, t('prereqOk')),
            )
          : null
        return banner
          ? h('div', { className: 'dwhd-stage' },
              h('style', { key: 'css' }, CSS),
              banner,
            )
          : null
      }

      const badge = dance.dj ? t('dj') : t('original')
      const sourceLabel = dance.audioSource === 'none' ? t('synth') : ''
      const bilibiliUrl = typeof dance.bilibiliUrl === 'string' ? dance.bilibiliUrl : null
      const banner = showPrereq && !prereqDismissed
        ? h('div', { className: 'dwhd-prereq', role: 'alert' },
            h('h3', null, t('prereqTitle')),
            h('p', null, t('prereqBody')),
            h('button', {
              type: 'button',
              onClick: () => setPrereqDismissed(true),
            }, t('prereqOk')),
          )
        : null

      return h('div', {
        className: 'dwhd-stage',
        role: 'region',
        'aria-label': `${dance.song || ''} ${badge}`,
        ref: stageRef,
      },
        h('style', { key: 'css' }, CSS),
        banner,
        neonRects && neonRects.sidebar
          ? h('div', {
              className: 'dwhd-neon-frame',
              'aria-hidden': true,
              style: {
                left: neonRects.sidebar.left,
                top: neonRects.sidebar.top,
                width: neonRects.sidebar.width,
                height: neonRects.sidebar.height,
                borderRadius: neonRects.sidebar.radius,
              },
            })
          : null,
        neonRects && neonRects.composer
          ? h('div', {
              className: 'dwhd-neon-frame',
              'aria-hidden': true,
              style: {
                left: neonRects.composer.left,
                top: neonRects.composer.top,
                width: neonRects.composer.width,
                height: neonRects.composer.height,
                borderRadius: neonRects.composer.radius,
              },
            })
          : null,
        // 「金色传说」：聊天输入框外围一圈暖金光环
        neonRects && neonRects.composer
          ? h('div', {
              className: 'dwhd-gold-frame',
              'aria-hidden': true,
              style: {
                left: neonRects.composer.left - 6,
                top: neonRects.composer.top - 6,
                width: neonRects.composer.width + 12,
                height: neonRects.composer.height + 12,
                borderRadius: neonRects.composer.radius + 4,
              },
            })
          : null,
        h('div', { className: 'dwhd-orb-wrap', 'aria-hidden': true, ref: orbRef },
          h('div', { className: 'dwhd-cone' }),
          h('div', { className: 'dwhd-beam dwhd-beam-a' }),
          h('div', { className: 'dwhd-beam dwhd-beam-b' }),
          h('div', { className: 'dwhd-flare' }),
          h('div', { className: 'dwhd-halo' }),
          h('div', { className: 'dwhd-ray dwhd-ray-a' }),
          h('div', { className: 'dwhd-ray dwhd-ray-b' }),
          h('div', { className: 'dwhd-ray dwhd-ray-c' }),
          h('div', { className: 'dwhd-mount' }),
          h('div', { className: 'dwhd-ball-pulse', ref: ballPulseRef },
            h('div', { className: 'dwhd-ball' }, discoBallSvg()),
          ),
          h('span', { className: 'dwhd-spark' }),
          h('span', { className: 'dwhd-spark' }),
          h('span', { className: 'dwhd-spark' }),
          h('span', { className: 'dwhd-spark' }),
          h('span', { className: 'dwhd-spark', style: { left: '38%', top: '64%', animationDelay: '.9s' } }),
          h('span', { className: 'dwhd-spark', style: { right: '36%', top: '60%', animationDelay: '1.4s' } }),
          h('span', { className: 'dwhd-spark', style: { left: '52%', top: '80%', animationDelay: '.4s', background: '#ffd1f0' } }),
          h('span', { className: 'dwhd-spark', style: { right: '48%', top: '14%', animationDelay: '1.9s' } }),
        ),
        h('div', { className: 'dwhd-pool', 'aria-hidden': true }),
        h('div', { className: 'dwhd-flash', 'aria-hidden': true }),
        widgetReady
          ? h('div', {
              className: 'dwhd-speaker',
              ref: speakerRef,
              style: { width: speakerSize.width, height: speakerSize.height },
            },
              h('div', { className: 'dwhd-gold-aura', 'aria-hidden': true }),
              h('div', { className: 'dwhd-speaker-ring' }),
              speakerSvg(speakerSize.width, speakerSize.height),
            )
          : null,
        widgetReady && !nativeLyric
          ? h('div', {
              className: 'dwhd-bubble',
              ref: bubbleRef,
            },
              h('div', { className: 'dwhd-bubble-head' },
                h('span', { className: 'dwhd-bubble-title' }, dance.song || ''),
                h('span', { className: 'dwhd-badge' }, badge),
                sourceLabel ? h('span', { className: 'dwhd-badge' }, sourceLabel) : null,
                bilibiliUrl
                  ? h('a', {
                      className: 'dwhd-bubble-link',
                      href: bilibiliUrl,
                      target: '_blank',
                      rel: 'noreferrer noopener',
                    }, 'B站 ↗')
                  : null,
              ),
              h('div', { className: 'dwhd-bubble-lyric', 'aria-live': 'polite' }, keyLine || t('noLyric')),
              h('div', { className: 'dwhd-bubble-progress' },
                h('i', { style: { width: `${Math.round(progress * 100)}%` } }),
              ),
            )
          : null,
        h('div', {
          className: 'dwhd-hint',
          ref: hintRef,
          style: { top: `${hintAnchor.top}px`, right: `${hintAnchor.right}px` },
          onPointerDown: (event) => { event.stopPropagation() },
        },
          h('span', { className: 'dwhd-key' }, 'ESC'),
          h('span', null, t('endHint')),
          h('div', { className: 'dwhd-vol' },
            h('span', { className: 'dwhd-vol-icon', 'aria-hidden': true }, volume <= 0.001 ? '🔇' : (volume < 0.5 ? '🔉' : '🔊')),
            h('input', {
              className: 'dwhd-vol-range',
              type: 'range',
              min: 0,
              max: 100,
              step: 1,
              value: Math.round(volume * 100),
              'aria-label': t('volume'),
              title: t('volume'),
              onChange: (event) => { applyVolume(event.target.value) },
              onPointerDown: (event) => { event.stopPropagation() },
              onClick: (event) => { event.stopPropagation() },
            }),
            h('span', { className: 'dwhd-vol-value' }, `${Math.round(volume * 100)}%`),
          ),
          h('button', {
            className: 'dwhd-stop',
            type: 'button',
            onClick: () => { stopRef.current?.(true) },
          }, t('stopNow')),
        ),
        needsTap
          ? h('button', { className: 'dwhd-tap', type: 'button', onClick: tapToPlay },
              dance.audioUrl ? t('tapToPlay') : t('tapBeat'))
          : null,
      )
    }

    function apply(ctx) {
      let translate = (key) => DICT.zh[key] || key
      const locale = ctx.get?.('locale') || ctx.locale
      if (locale && typeof locale.register === 'function') {
        try { ctx.effect(() => locale.register(NS, DICT), 'dsh-whale-dance: locale') } catch {}
      }
      if (locale && typeof locale.bind === 'function') {
        try {
          const bound = locale.bind(NS)
          if (typeof bound === 'function') {
            translate = (key) => {
              try { return bound(key) } catch { return DICT.zh[key] || key }
            }
          }
        } catch {}
      }
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-whale-dance',
        order: 60,
        inject: () => ({ t: translate }),
      }, DanceOverlay)), 'dsh-whale-dance: overlay')
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
