// Minimal WebAudio UI feedback — synthesized clicks for hover/select/tab/back/toggle.
// Ported from the reference pause-menu kit. Attaches to window.AudioFX so any
// module (viewer, app) can call it without an explicit import.

let ctx = null;
let enabled = true;

function ensure() {
	if (!ctx) {
		try {
			ctx = new (window.AudioContext || window.webkitAudioContext)();
		} catch (e) {
			ctx = null;
		}
	}
	return ctx;
}

function blip({ freq = 600, dur = 0.04, type = 'square', gain = 0.04, slide = 0 } = {}) {
	if (!enabled) return;
	const c = ensure();
	if (!c) return;
	// Autoplay policy: resume the context on first user gesture.
	if (c.state === 'suspended') {
		try {
			c.resume();
		} catch (e) {}
	}
	const t = c.currentTime;
	const o = c.createOscillator();
	const g = c.createGain();
	o.type = type;
	o.frequency.setValueAtTime(freq, t);
	if (slide) {
		o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
	}
	g.gain.setValueAtTime(0, t);
	g.gain.linearRampToValueAtTime(gain, t + 0.003);
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	o.connect(g);
	g.connect(c.destination);
	o.start(t);
	o.stop(t + dur + 0.02);
}

const AudioFX = {
	setEnabled(v) {
		enabled = !!v;
	},
	isEnabled() {
		return enabled;
	},
	hover() {
		blip({ freq: 1200, dur: 0.025, gain: 0.015, type: 'square' });
	},
	tab() {
		blip({ freq: 420, dur: 0.08, gain: 0.05, type: 'sawtooth', slide: -60 });
	},
	select() {
		blip({ freq: 900, dur: 0.06, gain: 0.05, type: 'square', slide: 400 });
	},
	back() {
		blip({ freq: 500, dur: 0.06, gain: 0.04, type: 'square', slide: -200 });
	},
	toggle() {
		blip({ freq: 700, dur: 0.03, gain: 0.03, type: 'square' });
	},
};

window.AudioFX = AudioFX;
export default AudioFX;
