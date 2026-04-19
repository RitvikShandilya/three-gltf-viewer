import * as THREE from 'three';
import WebGL from 'three/addons/capabilities/WebGL.js';
import { Viewer } from './viewer.js';
import { SimpleDropzone } from 'simple-dropzone';
import { Validator } from './validator.js';
import queryString from 'query-string';

window.THREE = THREE;
window.VIEWER = {};

if (!(window.File && window.FileReader && window.FileList && window.Blob)) {
	console.error('The File APIs are not fully supported in this browser.');
} else if (!WebGL.isWebGL2Available()) {
	console.error('WebGL is not supported in this browser.');
}

class App {
	/**
	 * @param  {Element} el
	 * @param  {Location} location
	 */
	constructor(el, location) {
		const hash = location.hash ? queryString.parse(location.hash) : {};
		this.options = {
			kiosk: Boolean(hash.kiosk),
			model: hash.model || '',
			preset: hash.preset || '',
			cameraPosition: hash.cameraPosition ? hash.cameraPosition.split(',').map(Number) : null,
		};

		this.el = el;
		this.viewer = null;
		this.viewerEl = null;
		this.spinnerEl = el.querySelector('.spinner');
		this.dropEl = el.querySelector('.dropzone');
		this.inputEl = el.querySelector('#file-input');
		this.validator = new Validator(el);

		this.createSpinner();
		this.createDropzone();
		this.createDragFeedback();
		this.hideSpinner();

		// Toast container + public API
		this.toastsEl = document.getElementById('pm-toasts');
		window.VIEWER.toast = (message, opts) => this.toast(message, opts);

		const options = this.options;

		if (options.kiosk) {
			document.body.dataset.menuOpen = 'false';
			document.body.dataset.kiosk = 'true';
		}

		if (options.model) {
			this.view(options.model, '', new Map());
		}
	}

	/**
	 * Sets up the drag-and-drop controller.
	 */
	createDropzone() {
		const dropCtrl = new SimpleDropzone(this.dropEl, this.inputEl);
		dropCtrl.on('drop', ({ files }) => this.load(files));
		dropCtrl.on('dropstart', () => this.showSpinner());
		dropCtrl.on('droperror', () => this.hideSpinner());
	}

	/**
	 * Adds visual feedback to the dropzone while the user drags a file
	 * over the window. Uses a simple enter/leave counter so transient
	 * child-to-child dragleave events don't cause the active state to
	 * flicker. Works both on the initial dropzone and when the pause
	 * menu is open (body-level class also toggled).
	 */
	createDragFeedback() {
		// Only engage when the drag actually carries files. Browsers
		// expose `DataTransfer.types` during dragenter/over without
		// leaking file contents.
		const hasFiles = (e) => {
			const dt = e.dataTransfer;
			if (!dt) return false;
			const types = dt.types;
			if (!types) return false;
			// `types` is a DOMStringList in some browsers.
			for (let i = 0; i < types.length; i++) {
				if (types[i] === 'Files') return true;
			}
			return false;
		};

		let depth = 0;

		const activate = () => {
			if (this.dropEl) this.dropEl.classList.add('dropzone--active');
			document.body.classList.add('dropzone--active');
		};

		const deactivate = () => {
			depth = 0;
			if (this.dropEl) this.dropEl.classList.remove('dropzone--active');
			document.body.classList.remove('dropzone--active');
		};

		window.addEventListener('dragenter', (e) => {
			if (!hasFiles(e)) return;
			depth++;
			activate();
		});

		window.addEventListener('dragover', (e) => {
			if (!hasFiles(e)) return;
			// Required so `drop` fires on the window.
			e.preventDefault();
			// If a drag somehow bypassed dragenter (e.g. tab-focus race),
			// make sure we still show feedback.
			if (!document.body.classList.contains('dropzone--active')) {
				activate();
			}
		});

		window.addEventListener('dragleave', (e) => {
			if (!hasFiles(e)) {
				// Not a file drag; ignore.
				return;
			}
			depth--;
			// The only reliable cross-browser "drag left the window" signal:
			// relatedTarget is null, or the pointer is at the viewport edge.
			const leftWindow =
				e.relatedTarget == null ||
				(e.clientX <= 0 && e.clientY <= 0) ||
				e.clientX >= window.innerWidth ||
				e.clientY >= window.innerHeight;
			if (depth <= 0 || leftWindow) {
				deactivate();
			}
		});

		window.addEventListener('drop', () => {
			deactivate();
		});

		// Safety net: if the tab loses focus mid-drag, clear the state
		// so it doesn't get stuck on.
		window.addEventListener('blur', deactivate);
	}

	/**
	 * Sets up the view manager.
	 * @return {Viewer}
	 */
	createViewer() {
		this.viewerEl = document.createElement('div');
		this.viewerEl.classList.add('viewer');
		this.dropEl.innerHTML = '';
		this.dropEl.appendChild(this.viewerEl);
		this.viewer = new Viewer(this.viewerEl, this.options);
		return this.viewer;
	}

	/**
	 * Loads a fileset provided by user action.
	 * @param  {Map<string, File>} fileMap
	 */
	load(fileMap) {
		let rootFile;
		let rootPath;
		Array.from(fileMap).forEach(([path, file]) => {
			if (file.name.match(/\.(gltf|glb)$/)) {
				rootFile = file;
				rootPath = path.replace(file.name, '');
			}
		});

		if (!rootFile) {
			this.onError('No .gltf or .glb asset found.');
		}

		this.view(rootFile, rootPath, fileMap);
	}

	/**
	 * Passes a model to the viewer, given file and resources.
	 * @param  {File|string} rootFile
	 * @param  {string} rootPath
	 * @param  {Map<string, File>} fileMap
	 */
	view(rootFile, rootPath, fileMap) {
		if (this.viewer) this.viewer.clear();

		const viewer = this.viewer || this.createViewer();

		const fileURL = typeof rootFile === 'string' ? rootFile : URL.createObjectURL(rootFile);

		const cleanup = () => {
			this.hideSpinner();
			if (typeof rootFile === 'object') URL.revokeObjectURL(fileURL);
		};

		// Reset progress to 0% before each load so stale values don't linger.
		this.resetProgress();

		viewer
			.load(fileURL, rootPath, fileMap, (e) => this.updateProgress(e))
			.catch((e) => this.onError(e))
			.then((gltf) => {
				// TODO: GLTFLoader parsing can fail on invalid files. Ideally,
				// we could run the validator either way.
				if (!this.options.kiosk) {
					this.validator.validate(fileURL, rootPath, fileMap, gltf);
				}
				if (gltf) {
					const name =
						(typeof rootFile === 'string'
							? rootFile.split('/').pop().split('?')[0]
							: rootFile && rootFile.name) || 'MODEL';
					this.toast(`MODEL LOADED · ${name}`, { level: 'success' });
				}
				cleanup();
			});
	}

	/**
	 * @param  {Error} error
	 */
	onError(error) {
		let message = (error || {}).message || error.toString();
		if (message.match(/ProgressEvent/)) {
			message = 'Unable to retrieve this file. Check JS console and browser network tab.';
		} else if (message.match(/Unexpected token/)) {
			message = `Unable to parse file content. Verify that this file is valid. Error: "${message}"`;
		} else if (error && error.target && error.target instanceof Image) {
			message = 'Missing texture: ' + error.target.src.split('/').pop();
		}
		this.toast(message, { level: 'error', duration: 5000 });
		console.error(error);
	}

	/**
	 * GTA V-style inline toast notification.
	 * @param  {string} message
	 * @param  {{level?: 'error'|'info'|'success', duration?: number}} [opts]
	 */
	toast(message, opts) {
		const container = this.toastsEl || document.getElementById('pm-toasts');
		if (!container) return;
		const level = (opts && opts.level) || 'info';
		const duration = (opts && typeof opts.duration === 'number') ? opts.duration : 3000;

		const el = document.createElement('div');
		el.className = `pm__toast pm__toast--${level}`;
		el.setAttribute('role', level === 'error' ? 'alert' : 'status');
		el.textContent = String(message == null ? '' : message);

		const dismiss = () => {
			if (el.dataset.dismissed === '1') return;
			el.dataset.dismissed = '1';
			el.classList.add('pm__toast--leaving');
			el.addEventListener(
				'transitionend',
				() => el.parentNode && el.parentNode.removeChild(el),
				{ once: true },
			);
			// Fallback removal in case transitionend doesn't fire.
			setTimeout(() => {
				if (el.parentNode) el.parentNode.removeChild(el);
			}, 400);
		};

		el.addEventListener('click', dismiss);

		container.appendChild(el);
		// Next frame: trigger slide-up/fade-in.
		requestAnimationFrame(() => el.classList.add('pm__toast--in'));

		if (duration > 0) setTimeout(dismiss, duration);
		return el;
	}

	showSpinner() {
		this.spinnerEl.style.display = '';
		this.resetProgress();
	}

	hideSpinner() {
		this.spinnerEl.style.display = 'none';
		this.resetProgress();
	}

	/**
	 * Populates the .spinner element with the GTA V-style loading
	 * screen: 4 rotating accent-tinted character-art cards with
	 * halftone + grain overlays, a vignette, and a "LOADING..."
	 * label in the bottom-right corner.
	 */
	createSpinner() {
		if (!this.spinnerEl) return;
		// Avoid re-init on hot reload
		if (this.spinnerEl.dataset.gta === '1') return;
		this.spinnerEl.dataset.gta = '1';
		this.spinnerEl.setAttribute('role', 'status');
		this.spinnerEl.setAttribute('aria-live', 'polite');
		this.spinnerEl.setAttribute('aria-label', 'Loading model');

		// Four distinct character-style silhouettes (geometric placeholders).
		// Each uses a bold negative-space portrait reminiscent of GTA V
		// character art: head-and-shoulders with a signature prop.
		const silhouettes = [
			// 1. Lester-style: hunched figure, big glasses
			`<svg viewBox="0 0 400 560" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
				<defs>
					<linearGradient id="gta-tint-1" x1="0" x2="0" y1="0" y2="1">
						<stop offset="0%" stop-color="#FCB131" stop-opacity="0.95"/>
						<stop offset="100%" stop-color="#7a4d00" stop-opacity="0.9"/>
					</linearGradient>
				</defs>
				<g fill="url(#gta-tint-1)">
					<path d="M120 560 C 120 410 140 370 200 370 C 260 370 280 410 280 560 Z"/>
					<ellipse cx="200" cy="260" rx="78" ry="92"/>
					<rect x="140" y="240" width="60" height="36" rx="8" fill="#000"/>
					<rect x="200" y="240" width="60" height="36" rx="8" fill="#000"/>
					<rect x="196" y="252" width="8" height="4" fill="#000"/>
					<path d="M145 340 L255 340 L250 360 L150 360 Z" fill="#000" opacity="0.6"/>
				</g>
			</svg>`,
			// 2. Michael-style: suited man, slicked-back hair
			`<svg viewBox="0 0 400 560" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
				<defs>
					<linearGradient id="gta-tint-2" x1="0" x2="0" y1="0" y2="1">
						<stop offset="0%" stop-color="#65B4D4" stop-opacity="0.95"/>
						<stop offset="100%" stop-color="#1e4757" stop-opacity="0.9"/>
					</linearGradient>
				</defs>
				<g fill="url(#gta-tint-2)">
					<path d="M90 560 L 150 380 L 250 380 L 310 560 Z"/>
					<ellipse cx="200" cy="250" rx="82" ry="100"/>
					<path d="M120 210 C 130 150 170 130 200 130 C 230 130 270 150 280 210 L 270 230 L 130 230 Z" fill="#000" opacity="0.55"/>
					<path d="M170 390 L 200 440 L 230 390 L 220 560 L 180 560 Z" fill="#000" opacity="0.7"/>
				</g>
			</svg>`,
			// 3. Franklin-style: hoodie, determined stance
			`<svg viewBox="0 0 400 560" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
				<defs>
					<linearGradient id="gta-tint-3" x1="0" x2="0" y1="0" y2="1">
						<stop offset="0%" stop-color="#ABEDAB" stop-opacity="0.95"/>
						<stop offset="100%" stop-color="#2d5a2d" stop-opacity="0.9"/>
					</linearGradient>
				</defs>
				<g fill="url(#gta-tint-3)">
					<path d="M80 560 L 110 360 C 140 340 180 330 200 330 C 220 330 260 340 290 360 L 320 560 Z"/>
					<ellipse cx="200" cy="240" rx="74" ry="88"/>
					<path d="M100 340 C 120 280 170 270 200 270 C 230 270 280 280 300 340 L 280 360 C 250 330 220 325 200 325 C 180 325 150 330 120 360 Z" fill="#000" opacity="0.5"/>
					<circle cx="200" cy="250" r="40" fill="#000" opacity="0.35"/>
				</g>
			</svg>`,
			// 4. Trevor-style: wild, shouting, raised fist
			`<svg viewBox="0 0 400 560" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
				<defs>
					<linearGradient id="gta-tint-4" x1="0" x2="0" y1="0" y2="1">
						<stop offset="0%" stop-color="#FFA357" stop-opacity="0.95"/>
						<stop offset="100%" stop-color="#6b3510" stop-opacity="0.9"/>
					</linearGradient>
				</defs>
				<g fill="url(#gta-tint-4)">
					<path d="M90 560 L 120 400 L 180 380 L 220 380 L 280 400 L 310 560 Z"/>
					<ellipse cx="200" cy="240" rx="78" ry="94"/>
					<ellipse cx="172" cy="230" rx="8" ry="4" fill="#000"/>
					<ellipse cx="228" cy="230" rx="8" ry="4" fill="#000"/>
					<path d="M160 290 Q 200 320 240 290 L 240 310 Q 200 330 160 310 Z" fill="#000" opacity="0.7"/>
					<rect x="300" y="150" width="50" height="60" rx="10" transform="rotate(-12 325 180)"/>
					<rect x="290" y="200" width="30" height="160" transform="rotate(-8 305 280)"/>
				</g>
			</svg>`,
		];

		const cardsHTML = silhouettes
			.map(
				(svg) => `
				<div class="spinner__card">
					<div class="spinner__card-bg"></div>
					<div class="spinner__card-art">${svg}</div>
					<div class="spinner__card-halftone"></div>
					<div class="spinner__card-grain"></div>
				</div>`,
			)
			.join('');

		this.spinnerEl.innerHTML = `
			<div class="spinner__deck">${cardsHTML}</div>
			<div class="spinner__vignette" aria-hidden="true"></div>
			<div class="spinner__loading" aria-hidden="true">
				<span class="spinner__loading-label">LOADING</span>
				<span class="spinner__dots">
					<span>.</span><span>.</span><span>.</span>
				</span>
			</div>
			<div class="pm__progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Loading progress">
				<div class="pm__progress-track">
					<div class="pm__progress-bar" id="pm-progress-bar"></div>
				</div>
				<div class="pm__progress-label" id="pm-progress-label">0%</div>
			</div>
		`;

		// Cache refs for progress updates.
		this.progressEl = this.spinnerEl.querySelector('.pm__progress');
		this.progressBarEl = this.spinnerEl.querySelector('#pm-progress-bar');
		this.progressLabelEl = this.spinnerEl.querySelector('#pm-progress-label');
	}

	/**
	 * Resets the loading progress bar to 0% and clears indeterminate state.
	 */
	resetProgress() {
		if (!this.progressEl) return;
		this.progressEl.classList.remove('pm__progress--indeterminate');
		if (this.progressBarEl) this.progressBarEl.style.width = '0%';
		if (this.progressLabelEl) this.progressLabelEl.textContent = '0%';
		this.progressEl.setAttribute('aria-valuenow', '0');
	}

	/**
	 * Updates loading progress from an XHR-like event.
	 * @param {{loaded: number, total: number}} e
	 */
	updateProgress(e) {
		if (!this.progressEl) return;
		const loaded = (e && e.loaded) || 0;
		const total = (e && e.total) || 0;
		if (!total || !isFinite(total)) {
			// Unknown total — indeterminate pulsing state.
			this.progressEl.classList.add('pm__progress--indeterminate');
			if (this.progressBarEl) this.progressBarEl.style.width = '';
			if (this.progressLabelEl) {
				const kb = Math.round(loaded / 1024);
				this.progressLabelEl.textContent = kb > 0 ? `${kb.toLocaleString()} KB` : '···';
			}
			this.progressEl.removeAttribute('aria-valuenow');
			return;
		}
		this.progressEl.classList.remove('pm__progress--indeterminate');
		const pct = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
		if (this.progressBarEl) this.progressBarEl.style.width = `${pct}%`;
		if (this.progressLabelEl) this.progressLabelEl.textContent = `${pct}%`;
		this.progressEl.setAttribute('aria-valuenow', String(pct));
	}
}

document.addEventListener('DOMContentLoaded', () => {
	const app = new App(document.body, location);

	window.VIEWER.app = app;

	console.info('[glTF Viewer] Debugging data exported as `window.VIEWER`.');
});
