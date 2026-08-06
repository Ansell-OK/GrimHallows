let audioCtx: AudioContext | null = null;
let bgmOsc: OscillatorNode | null = null;
let bgmGain: GainNode | null = null;

const getContext = () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioCtx;
};

export const playSfx = (type: 'click' | 'hover' | 'combat' | 'error') => {
  const ctx = getContext();
  if (ctx.state === 'suspended') ctx.resume();

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  
  osc.connect(gain);
  gain.connect(ctx.destination);

  if (type === 'click') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  } else if (type === 'hover') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, ctx.currentTime);
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);
  } else if (type === 'combat') {
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(100, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  }
};

export const startBgm = () => {
  const ctx = getContext();
  if (bgmOsc) return; // Already playing

  bgmOsc = ctx.createOscillator();
  bgmGain = ctx.createGain();
  
  bgmOsc.type = 'sine';
  bgmOsc.frequency.setValueAtTime(55, ctx.currentTime); // Low drone (A1)
  
  // Add some modulation
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.1;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 10;
  lfo.connect(lfoGain);
  lfoGain.connect(bgmOsc.frequency);
  lfo.start();

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 400;

  bgmOsc.connect(filter);
  filter.connect(bgmGain);
  bgmGain.connect(ctx.destination);

  bgmGain.gain.setValueAtTime(0, ctx.currentTime);
  bgmGain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 2); // Fade in
  
  bgmOsc.start();
};

export const stopBgm = () => {
  if (bgmOsc && bgmGain) {
    const ctx = getContext();
    bgmGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1);
    setTimeout(() => {
      bgmOsc?.stop();
      bgmOsc = null;
      bgmGain = null;
    }, 1000);
  }
};
