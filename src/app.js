import * as THREE from 'three';
import WebGL from 'three/addons/capabilities/WebGL.js';
import { Viewer } from './viewer.js';
import { SimpleDropzone } from 'simple-dropzone';
import { Validator } from './validator.js';
import './audio-fx.js';
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
	 * over the window. Uses a short debounced "last seen dragover"
	 * timestamp to derive the active state — this is dramatically more
	 * robust than enter/leave counters, which routinely desync when
	 * drags cross nested elements, devtools overlays, or iframes.
	 *
	 * We deliberately DO NOT paint any fullscreen "DROP TO LOAD" text;
	 * the perimeter highlight on the dropzone itself is sufficient and
	 * less jarring (matches GTA V pause-menu UX).
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
			for (let i = 0; i < types.length; i++) {
				if (types[i] === 'Files') return true;
			}
			return false;
		};

		let idleTimer = null;
		const IDLE_MS = 120;

		const activate = () => {
			if (this.dropEl) this.dropEl.classList.add('dropzone--active');
			document.body.classList.add('dropzone--active');
		};

		const deactivate = () => {
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = null;
			}
			if (this.dropEl) this.dropEl.classList.remove('dropzone--active');
			document.body.classList.remove('dropzone--active');
		};
		// Expose so createViewer() and other lifecycle points can force
		// a cleanup (defensive — avoids any stuck-overlay class state).
		this._clearDragFeedback = deactivate;

		const bump = () => {
			activate();
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(deactivate, IDLE_MS);
		};

		window.addEventListener('dragenter', (e) => {
			if (!hasFiles(e)) return;
			bump();
		});

		window.addEventListener('dragover', (e) => {
			if (!hasFiles(e)) return;
			// Required so `drop` fires inside the window.
			e.preventDefault();
			bump();
		});

		// dragleave is unreliable across nested targets; we rely on the
		// idle timer instead. Only treat an explicit window-exit as a
		// hard deactivate.
		window.addEventListener('dragleave', (e) => {
			if (!hasFiles(e)) return;
			if (e.relatedTarget == null) deactivate();
		});

		// Hard resets — any of these must clear the class.
		window.addEventListener('drop', deactivate);
		window.addEventListener('dragend', deactivate);
		window.addEventListener('blur', deactivate);
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) deactivate();
		});
		// Escape key -> cancel any stuck feedback.
		window.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') deactivate();
		});
	}

	/**
	 * Sets up the view manager.
	 * @return {Viewer}
	 */
	createViewer() {
		// Force-clear any stale drag-feedback state before we replace the
		// dropzone contents — avoids the "DROP TO LOAD" / perimeter
		// highlight being stuck after a successful load.
		if (typeof this._clearDragFeedback === 'function') this._clearDragFeedback();
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
					// Unlock the pause menu UI (floating Menu toggle and
					// settings overlay). Before this class is set, those
					// elements stay hidden so the dropzone isn't cluttered
					// with ghost chrome.
					document.body.classList.add('has-model');
					const name =
						(typeof rootFile === 'string'
							? rootFile.split('/').pop().split('?')[0]
							: rootFile && rootFile.name) || 'model';
					// Stash the original filename on the viewer so the GLB
					// export flow can reuse it (with a .glb extension) when
					// naming the downloaded file.
					if (this.viewer) this.viewer._originalFilename = name;
					// Update the pause-menu session chip (top-left brand area)
					// with the loaded filename. The chip mirrors Grand-Figma-
					// Kit's "Menu Badge" pattern, showing current context next
					// to the brand title. Hidden when empty via CSS :empty.
					const sessionEl = document.getElementById('pm-session');
					if (sessionEl) sessionEl.textContent = name;
					this.toast(`Loaded ${name}`, { level: 'success' });
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

		// GTA V blip-style badge (Figma Grand-Kit, node 1201:5450). The
		// tinted border/glow comes from --toast-accent via .pm__toast-icon.
		const glyph = level === 'success' ? 'OK'
			: level === 'error' ? '!'
			: 'i';
		const icon = document.createElement('span');
		icon.className = 'pm__toast-icon';
		icon.setAttribute('aria-hidden', 'true');
		icon.textContent = glyph;

		const text = document.createElement('span');
		text.className = 'pm__toast-text';
		text.textContent = String(message == null ? '' : message);

		el.appendChild(icon);
		el.appendChild(text);

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
	 * Minimal loading overlay: solid background, a label, and a
	 * determinate/indeterminate progress bar centered near the bottom.
	 */
	createSpinner() {
		if (!this.spinnerEl) return;
		// Avoid re-init on hot reload
		if (this.spinnerEl.dataset.init === '1') return;
		this.spinnerEl.dataset.init = '1';
		this.spinnerEl.setAttribute('role', 'status');
		this.spinnerEl.setAttribute('aria-live', 'polite');
		this.spinnerEl.setAttribute('aria-label', 'Loading model');

		this.spinnerEl.innerHTML = `
			<div class="spinner__loading" aria-hidden="true">Loading</div>
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
