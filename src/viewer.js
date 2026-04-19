import {
	AmbientLight,
	AnimationMixer,
	AxesHelper,
	Box3,
	Cache,
	CanvasTexture,
	Color,
	DirectionalLight,
	GridHelper,
	HemisphereLight,
	LoaderUtils,
	LoadingManager,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	PCFSoftShadowMap,
	PMREMGenerator,
	PerspectiveCamera,
	PlaneGeometry,
	PointsMaterial,
	REVISION,
	RepeatWrapping,
	RingGeometry,
	Scene,
	SkeletonHelper,
	SRGBColorSpace,
	Texture,
	Vector2,
	Vector3,
	WebGLRenderer,
	LinearToneMapping,
	ACESFilmicToneMapping,
	DoubleSide,
} from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { FilmPass } from 'three/addons/postprocessing/FilmPass.js';

import { environments } from './environments.js';

const DEFAULT_CAMERA = '[default]';

const MANAGER = new LoadingManager();
const THREE_PATH = `https://unpkg.com/three@0.${REVISION}.x`;
const DRACO_LOADER = new DRACOLoader(MANAGER).setDecoderPath(
	`${THREE_PATH}/examples/jsm/libs/draco/gltf/`,
);
const KTX2_LOADER = new KTX2Loader(MANAGER).setTranscoderPath(
	`${THREE_PATH}/examples/jsm/libs/basis/`,
);

const IS_IOS = isIOS();

/**
 * Coarse-pointer (touch-first) device detection. Used to default expensive
 * post-processing passes (SSAO, bloom) OFF on mobile, where the GPU budget
 * is tight and the user usually hasn't opted into eye-candy. Prefer the CSS
 * media query since it also catches hybrid laptop/tablet devices in touch
 * mode; fall back to a UA sniff for very old browsers.
 */
const IS_MOBILE = (() => {
	try {
		if (typeof window !== 'undefined' && window.matchMedia) {
			if (window.matchMedia('(pointer: coarse)').matches) return true;
		}
	} catch (e) {}
	try {
		return /Android|iPhone|iPad|iPod|IEMobile|BlackBerry/i.test(
			(typeof navigator !== 'undefined' && navigator.userAgent) || '',
		);
	} catch (e) {
		return false;
	}
})();

const Preset = { ASSET_GENERATOR: 'assetgenerator' };

Cache.enabled = true;

export class Viewer {
	constructor(el, options) {
		this.el = el;
		this.options = options;

		this.lights = [];
		this.content = null;
		this.mixer = null;
		this.clips = [];

		this.state = {
			environment:
				options.preset === Preset.ASSET_GENERATOR
					? environments.find((e) => e.id === 'footprint-court').name
					: environments[1].name,
			background: true,
			playbackSpeed: 1.0,
			actionStates: {},
			camera: DEFAULT_CAMERA,
			wireframe: false,
			skeleton: false,
			grid: false,
			ground: true,
			autoRotate: false,
			followCamera: false,
			freePan: false,

			// Lights
			punctualLights: true,
			exposure: 0.0,
			toneMapping: ACESFilmicToneMapping,
			ambientIntensity: 0.3,
			ambientColor: '#FFFFFF',
			directIntensity: 0.8 * Math.PI, // TODO(#116)
			directColor: '#FFFFFF',
			bgColor: '#0a0a0a',

			pointSize: 1.0,

			// Post-processing. Expensive passes (bloom / SSAO) are OFF by
			// default everywhere; this is doubly important on mobile where
			// they can halve the framerate. If the user enables SSAO on a
			// coarse-pointer device we surface a one-time warning toast
			// (see the ssao schema row below).
			bloom: false,
			bloomStrength: 0.5,
			bloomThreshold: 0.85,
			bloomRadius: 0.4,
			ssao: false,
			ssaoStrength: 1.0,
			filmGrain: false,
			filmGrainIntensity: 0.35,
		};

		// Snapshot original defaults for per-tab RESET chips.
		this._defaults = JSON.parse(JSON.stringify(this.state));

		this.prevTime = 0;

		this.stats = new Stats();
		this.stats.dom.height = '48px';
		[].forEach.call(this.stats.dom.children, (child) => (child.style.display = ''));

		this.backgroundColor = new Color(this.state.bgColor);

		this.scene = new Scene();
		this.scene.background = this.backgroundColor;

		const fov = options.preset === Preset.ASSET_GENERATOR ? (0.8 * 180) / Math.PI : 60;
		const aspect = el.clientWidth / el.clientHeight;
		this.defaultCamera = new PerspectiveCamera(fov, aspect, 0.01, 1000);
		this.activeCamera = this.defaultCamera;
		this.scene.add(this.defaultCamera);

		this.renderer = window.renderer = new WebGLRenderer({ antialias: true });
		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.setSize(el.clientWidth, el.clientHeight);
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = PCFSoftShadowMap;

		this.pmremGenerator = new PMREMGenerator(this.renderer);
		this.pmremGenerator.compileEquirectangularShader();

		this.neutralEnvironment = this.pmremGenerator.fromScene(new RoomEnvironment()).texture;

		this.controls = new OrbitControls(this.defaultCamera, this.renderer.domElement);
		this.controls.screenSpacePanning = true;

		this.el.appendChild(this.renderer.domElement);

		// Post-processing pipeline. Lazily activated; when all post-fx are off,
		// render() bypasses the composer and uses the raw WebGLRenderer path.
		this._setupPostProcessing(el.clientWidth, el.clientHeight);

		this.skeletonHelpers = [];
		this.gridHelper = null;
		this.axesHelper = null;
		this.groundPlane = null;
		this.groundRing = null;

		this.addAxesHelper();

		// Restore shareable state from ?s=<base64> BEFORE building the schema,
		// so initial renders reflect the incoming settings.
		this._applyStateFromUrl();

		this.addGUI();

		// Push any URL-restored post-fx values into the pass objects.
		this._updatePostProcessing();

		this.animate = this.animate.bind(this);
		requestAnimationFrame(this.animate);
		window.addEventListener('resize', this.resize.bind(this), false);
	}

	animate(time) {
		requestAnimationFrame(this.animate);

		const dt = (time - this.prevTime) / 1000;

		this.mixer && this.mixer.update(dt);

		// FOLLOW CAMERA: track animated content root each frame so the
		// OrbitControls target chases it (e.g., walking characters).
		if (
			this.state.followCamera &&
			this.content &&
			this.mixer &&
			this.clips &&
			this.clips.length
		) {
			if (!this._followTargetVec) this._followTargetVec = new Vector3();
			this.content.getWorldPosition(this._followTargetVec);
			this.controls.target.copy(this._followTargetVec);
		}

		this.controls.update();
		this.stats.update();
		this.render();

		this.prevTime = time;
	}

	render() {
		// Keep RenderPass synced with the currently active camera — it may have
		// been swapped via setCamera() when switching between the default camera
		// and a camera embedded in the loaded glTF.
		if (this.renderPass && this.renderPass.camera !== this.activeCamera) {
			this.renderPass.camera = this.activeCamera;
		}
		if (this.ssaoPass && this.ssaoPass.camera !== this.activeCamera) {
			this.ssaoPass.camera = this.activeCamera;
		}

		if (this._isPostFXEnabled()) {
			this.composer.render();
		} else {
			this.renderer.render(this.scene, this.activeCamera);
		}

		if (this.state.grid) {
			this.axesCamera.position.copy(this.defaultCamera.position);
			this.axesCamera.lookAt(this.axesScene.position);
			this.axesRenderer.render(this.axesScene, this.axesCamera);
		}
	}

	resize() {
		const { clientHeight, clientWidth } = this.el.parentElement;

		this.defaultCamera.aspect = clientWidth / clientHeight;
		this.defaultCamera.updateProjectionMatrix();
		this.renderer.setSize(clientWidth, clientHeight);

		if (this.composer) {
			this.composer.setSize(clientWidth, clientHeight);
		}
		if (this.bloomPass) {
			this.bloomPass.setSize(clientWidth, clientHeight);
		}
		if (this.ssaoPass) {
			this.ssaoPass.setSize(clientWidth, clientHeight);
		}

		this.axesCamera.aspect = this.axesDiv.clientWidth / this.axesDiv.clientHeight;
		this.axesCamera.updateProjectionMatrix();
		this.axesRenderer.setSize(this.axesDiv.clientWidth, this.axesDiv.clientHeight);
	}

	/**
	 * Build the EffectComposer and post-processing passes up front so we can
	 * toggle them on/off cheaply via state. Passes are all disabled by default
	 * so render() bypasses the composer entirely until the user opts in.
	 */
	_setupPostProcessing(width, height) {
		this.composer = new EffectComposer(this.renderer);
		this.composer.setPixelRatio(window.devicePixelRatio);
		this.composer.setSize(width, height);

		this.renderPass = new RenderPass(this.scene, this.activeCamera);
		this.composer.addPass(this.renderPass);

		// SSAO goes before bloom so bloom blooms the AO-darkened image, not
		// the other way around. Disabled by default.
		this.ssaoPass = new SSAOPass(this.scene, this.activeCamera, width, height);
		this.ssaoPass.kernelRadius = 8;
		this.ssaoPass.minDistance = 0.001;
		this.ssaoPass.maxDistance = 0.1;
		this.ssaoPass.enabled = false;
		this.composer.addPass(this.ssaoPass);

		this.bloomPass = new UnrealBloomPass(
			new Vector2(width, height),
			this.state.bloomStrength,
			this.state.bloomRadius,
			this.state.bloomThreshold,
		);
		this.bloomPass.enabled = false;
		this.composer.addPass(this.bloomPass);

		// FilmPass: noise + scanlines. We only use the noise (grayscale) channel
		// here; scanlines off. Disabled by default.
		this.filmPass = new FilmPass(this.state.filmGrainIntensity, false);
		this.filmPass.enabled = false;
		this.composer.addPass(this.filmPass);

		// OutputPass handles tone mapping + sRGB conversion correctly when the
		// composer is active (matches the direct renderer.render() path).
		this.outputPass = new OutputPass();
		this.composer.addPass(this.outputPass);
	}

	/** Any post-fx toggle on? If not, skip the composer for performance. */
	_isPostFXEnabled() {
		const s = this.state;
		return !!(s && (s.bloom || s.ssao || s.filmGrain));
	}

	/**
	 * Push state values into the live passes and flip their `enabled` flags.
	 * Called from every post-fx schema setter.
	 */
	_updatePostProcessing() {
		const s = this.state;
		if (this.bloomPass) {
			this.bloomPass.enabled = !!s.bloom;
			this.bloomPass.strength = s.bloomStrength;
			this.bloomPass.threshold = s.bloomThreshold;
			this.bloomPass.radius = s.bloomRadius;
		}
		if (this.ssaoPass) {
			this.ssaoPass.enabled = !!s.ssao;
			// SSAOPass exposes `output` + `kernelRadius`; translate strength to
			// a sensible kernel radius range so the slider has visible effect.
			this.ssaoPass.kernelRadius = 4 + s.ssaoStrength * 12;
		}
		if (this.filmPass) {
			this.filmPass.enabled = !!s.filmGrain;
			// three r176's FilmPass exposes uniforms on `.uniforms` (shader pass).
			const u = this.filmPass.uniforms;
			if (u && u.intensity) u.intensity.value = s.filmGrainIntensity;
		}
	}

	load(url, rootPath, assetMap, onProgress) {
		const baseURL = LoaderUtils.extractUrlBase(url);

		// Load.
		return new Promise((resolve, reject) => {
			// Intercept and override relative URLs.
			MANAGER.setURLModifier((url, path) => {
				// URIs in a glTF file may be escaped, or not. Assume that assetMap is
				// from an un-escaped source, and decode all URIs before lookups.
				// See: https://github.com/donmccurdy/three-gltf-viewer/issues/146
				const normalizedURL =
					rootPath +
					decodeURI(url)
						.replace(baseURL, '')
						.replace(/^(\.?\/)/, '');

				if (assetMap.has(normalizedURL)) {
					const blob = assetMap.get(normalizedURL);
					const blobURL = URL.createObjectURL(blob);
					blobURLs.push(blobURL);
					return blobURL;
				}

				return (path || '') + url;
			});

			const loader = new GLTFLoader(MANAGER)
				.setCrossOrigin('anonymous')
				.setDRACOLoader(DRACO_LOADER)
				.setKTX2Loader(KTX2_LOADER.detectSupport(this.renderer))
				.setMeshoptDecoder(MeshoptDecoder);

			const blobURLs = [];

			loader.load(
				url,
				(gltf) => {
					window.VIEWER.json = gltf;

					const scene = gltf.scene || gltf.scenes[0];
					const clips = gltf.animations || [];

					if (!scene) {
						// Valid, but not supported by this viewer.
						throw new Error(
							'This model contains no scene, and cannot be viewed here. However,' +
								' it may contain individual 3D resources.',
						);
					}

					this.setContent(scene, clips);

					blobURLs.forEach(URL.revokeObjectURL);

					// See: https://github.com/google/draco/issues/349
					// DRACOLoader.releaseDecoderModule();

					resolve(gltf);
				},
				(xhr) => {
					if (typeof onProgress === 'function') {
						const loaded = (xhr && xhr.loaded) || 0;
						const total = (xhr && xhr.total) || 0;
						onProgress({ loaded, total });
					}
				},
				reject,
			);
		});
	}

	/**
	 * @param {THREE.Object3D} object
	 * @param {Array<THREE.AnimationClip} clips
	 */
	setContent(object, clips) {
		this.clear();

		object.updateMatrixWorld(); // donmccurdy/three-gltf-viewer#330

		const box = new Box3().setFromObject(object);
		const sizeVec = box.getSize(new Vector3());
		const size = sizeVec.length();
		const center = box.getCenter(new Vector3());

		this.controls.reset();

		object.position.x -= center.x;
		object.position.y -= center.y;
		object.position.z -= center.z;

		// Sit the model on the ground plane (min.y == 0) instead of hovering half-below.
		object.position.y += sizeVec.y / 2;

		// Remember extents so the ground plane can be sized.
		this._modelSize = sizeVec.clone();

		this.controls.maxDistance = size * 10;
		this._defaultMaxDistance = size * 10;
		// Reapply free-pan overrides (if enabled) now that base defaults are set.
		this._applyFreePan();

		this.defaultCamera.near = size / 100;
		this.defaultCamera.far = size * 100;
		this.defaultCamera.updateProjectionMatrix();

		if (this.options.cameraPosition) {
			this.defaultCamera.position.fromArray(this.options.cameraPosition);
			this.defaultCamera.lookAt(new Vector3());
		} else {
			this.defaultCamera.position.copy(center);
			this.defaultCamera.position.x += size / 2.0;
			this.defaultCamera.position.y += size / 5.0;
			this.defaultCamera.position.z += size / 2.0;
			this.defaultCamera.lookAt(center);
		}

		this.setCamera(DEFAULT_CAMERA);

		this.axesCamera.position.copy(this.defaultCamera.position);
		this.axesCamera.lookAt(this.axesScene.position);
		this.axesCamera.near = size / 100;
		this.axesCamera.far = size * 100;
		this.axesCamera.updateProjectionMatrix();
		this.axesCorner.scale.set(size, size, size);

		this.controls.saveState();

		this.scene.add(object);
		this.content = object;

		this.state.punctualLights = true;

		const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

		this.content.traverse((node) => {
			if (node.isLight) {
				this.state.punctualLights = false;
			}
			if (node.isMesh) {
				node.castShadow = true;
				node.receiveShadow = true;

				// Crisp-up textures at oblique angles.
				const materials = Array.isArray(node.material) ? node.material : [node.material];
				for (const material of materials) {
					if (!material) continue;
					for (const key in material) {
						const value = material[key];
						if (value && value.isTexture) {
							value.anisotropy = maxAnisotropy;
						}
					}
				}
			}
		});

		this.setClips(clips);

		this.updateLights();
		this.updateGUI();
		this.updateEnvironment();
		this.updateDisplay();
		this._updateGround();

		window.VIEWER.scene = this.content;
		// Surface the fix routine so external UI (e.g. the validation report
		// toggle) can trigger the same cleanup used by the BRIEF tab button.
		window.VIEWER.fixGLTF = () => this._fixGLTF();
		// Surface the GLB exporter so external UI (validator toggle, keyboard
		// shortcuts, devtools) can download the current scene — including
		// anything mutated by _fixGLTF() or swapped assets — in one click.
		window.VIEWER.exportGLB = () => this._exportGLB();
	}

	/**
	 * @param {Array<THREE.AnimationClip} clips
	 */
	setClips(clips) {
		if (this.mixer) {
			this.mixer.stopAllAction();
			this.mixer.uncacheRoot(this.mixer.getRoot());
			this.mixer = null;
		}

		this.clips = clips;
		if (!clips.length) return;

		this.mixer = new AnimationMixer(this.content);
	}

	playAllClips() {
		this.clips.forEach((clip) => {
			this.mixer.clipAction(clip).reset().play();
			this.state.actionStates[clip.name] = true;
		});
	}

	/**
	 * @param {string} name
	 */
	setCamera(name) {
		if (name === DEFAULT_CAMERA) {
			this.controls.enabled = true;
			this.activeCamera = this.defaultCamera;
		} else {
			this.controls.enabled = false;
			this.content.traverse((node) => {
				if (node.isCamera && node.name === name) {
					this.activeCamera = node;
				}
			});
		}

		// Keep the post-processing passes pointed at the live camera.
		if (this.renderPass) this.renderPass.camera = this.activeCamera;
		if (this.ssaoPass) this.ssaoPass.camera = this.activeCamera;
	}

	_cameraPreset(preset) {
		if (!this.content) return;
		const box = new Box3().setFromObject(this.content);
		const size = box.getSize(new Vector3());
		const center = box.getCenter(new Vector3());
		const radius = Math.max(size.x, size.y, size.z);
		const dist = radius * 1.8 || 1;

		this.setCamera(DEFAULT_CAMERA);
		this.controls.target.copy(center);

		const cam = this.defaultCamera;
		switch (preset) {
			case 'top':
				cam.position.set(center.x, center.y + dist, center.z + 0.001);
				break;
			case 'front':
				cam.position.set(center.x, center.y, center.z + dist);
				break;
			case 'back':
				cam.position.set(center.x, center.y, center.z - dist);
				break;
			case 'side':
				cam.position.set(center.x + dist, center.y, center.z);
				break;
			case 'iso':
				cam.position.set(
					center.x + dist * 0.7,
					center.y + dist * 0.7,
					center.z + dist * 0.7,
				);
				break;
			case 'reset':
			default:
				cam.position.set(
					center.x + size.x / 2,
					center.y + size.y / 5,
					center.z + size.z / 2,
				);
				break;
		}
		cam.lookAt(center);
		cam.updateProjectionMatrix();
		this.controls.update();
	}

	updateLights() {
		const state = this.state;
		const lights = this.lights;

		if (state.punctualLights && !lights.length) {
			this.addLights();
		} else if (!state.punctualLights && lights.length) {
			this.removeLights();
		}

		this.renderer.toneMapping = Number(state.toneMapping);
		this.renderer.toneMappingExposure = Math.pow(2, state.exposure);

		if (lights.length === 2) {
			lights[0].intensity = state.ambientIntensity;
			lights[0].color.set(state.ambientColor);
			lights[1].intensity = state.directIntensity;
			lights[1].color.set(state.directColor);
		}
	}

	addLights() {
		const state = this.state;

		if (this.options.preset === Preset.ASSET_GENERATOR) {
			const hemiLight = new HemisphereLight();
			hemiLight.name = 'hemi_light';
			this.scene.add(hemiLight);
			this.lights.push(hemiLight);
			return;
		}

		const light1 = new AmbientLight(state.ambientColor, state.ambientIntensity);
		light1.name = 'ambient_light';
		this.defaultCamera.add(light1);

		const light2 = new DirectionalLight(state.directColor, state.directIntensity);
		// Angled position for a subtle rim-lit highlight on loaded content.
		light2.position.set(1, 1.5, 1).normalize();
		light2.name = 'main_light';
		light2.castShadow = true;
		light2.shadow.mapSize.set(2048, 2048);
		light2.shadow.bias = -0.0005;
		light2.shadow.normalBias = 0.02;
		const shadowCam = light2.shadow.camera;
		const shadowExtent = this._modelSize
			? Math.max(this._modelSize.x, this._modelSize.y, this._modelSize.z) * 2
			: 10;
		shadowCam.left = -shadowExtent;
		shadowCam.right = shadowExtent;
		shadowCam.top = shadowExtent;
		shadowCam.bottom = -shadowExtent;
		shadowCam.near = 0.01;
		shadowCam.far = shadowExtent * 10;
		shadowCam.updateProjectionMatrix();
		this.defaultCamera.add(light2);

		this.lights.push(light1, light2);
	}

	removeLights() {
		this.lights.forEach((light) => light.parent.remove(light));
		this.lights.length = 0;
	}

	updateEnvironment() {
		const environment = environments.filter(
			(entry) => entry.name === this.state.environment,
		)[0];

		if (!environment) return;

		this.getCubeMapTexture(environment)
			.then(({ envMap }) => {
				this.scene.environment = envMap;
				// Show the envMap as background whenever one is loaded,
				// unless the user has explicitly turned `background` off.
				if (envMap && this.state.background !== false) {
					this.scene.background = envMap;
				} else {
					this.scene.background = this.backgroundColor;
				}
			})
			.catch((err) => {
				console.error('Failed to load environment:', environment.name, err);
				this.scene.environment = null;
				this.scene.background = this.backgroundColor;
				if (window.VIEWER && window.VIEWER.toast) {
					window.VIEWER.toast(`ENV LOAD FAILED · ${environment.name}`, {
						level: 'error',
						duration: 4000,
					});
				}
			});
	}

	getCubeMapTexture(environment) {
		const { id, path, format } = environment;

		// neutral (THREE.RoomEnvironment)
		if (id === 'neutral') {
			return Promise.resolve({ envMap: this.neutralEnvironment });
		}

		// none
		if (id === '') {
			return Promise.resolve({ envMap: null });
		}

		// LRU cache for PMREM'd env maps. 4K HDRs produce sizeable GPU
		// textures, so we keep at most MAX_ENV_CACHE entries — when an entry
		// is evicted its `envMap.dispose()` is called to release GPU memory.
		// Map preserves insertion order, which we leverage as LRU order: any
		// cache hit re-inserts the id so it becomes most-recent.
		const MAX_ENV_CACHE = 2;
		this._envCache ||= new Map();
		if (this._envCache.has(id)) {
			const cached = this._envCache.get(id);
			// Refresh LRU order.
			this._envCache.delete(id);
			this._envCache.set(id, cached);
			return Promise.resolve({ envMap: cached });
		}

		// Pick loader by explicit `format` hint first, then by URL extension.
		// Note: `.hdr.jpg` (gain-map encoded HDR) requires HDRJPGLoader from
		// @monogrid/gainmap-js and is NOT parseable by RGBELoader. We currently
		// don't bundle that loader, so any .hdr.jpg entries will fail to load.
		const fmt = (format || '').toLowerCase();
		const isEXR = fmt === '.exr' || /\.exr(\?|$)/i.test(path);
		const Loader = isEXR ? EXRLoader : RGBELoader;

		// Dev-tools breadcrumb so we can confirm 4K HDRs are fetched on
		// demand (lazy), not at app startup.
		if (/_4k\.(hdr|exr)(\?|$)/i.test(path)) {
			console.info(`[viewer] fetching 4K HDRI lazily: ${id} — ${path}`);
		}

		// Hook into the App's spinner/progress UI (defined in app.js) so
		// users see a progress bar while multi-MB HDRs download. We poke
		// `window.VIEWER.app` rather than coupling Viewer to App directly.
		const app = typeof window !== 'undefined' && window.VIEWER ? window.VIEWER.app : null;
		const hasProgressUI =
			app &&
			typeof app.showSpinner === 'function' &&
			typeof app.hideSpinner === 'function' &&
			typeof app.updateProgress === 'function';
		if (hasProgressUI) {
			app.showSpinner();
			app.updateProgress({ loaded: 0, total: 0 });
		}

		return new Promise((resolve, reject) => {
			new Loader().load(
				path,
				(texture) => {
					const envMap = this.pmremGenerator.fromEquirectangular(texture).texture;
					texture.dispose();

					// Insert as most-recent, then evict oldest entries until
					// the cache is within bounds. Evicted env maps must have
					// their GPU memory released.
					this._envCache.set(id, envMap);
					while (this._envCache.size > MAX_ENV_CACHE) {
						const oldestKey = this._envCache.keys().next().value;
						if (oldestKey === id) break; // safety: never evict what we just added
						const oldest = this._envCache.get(oldestKey);
						this._envCache.delete(oldestKey);
						if (oldest && typeof oldest.dispose === 'function') {
							// If this envMap is still the active scene env/background,
							// null those refs first so three.js doesn't try to sample
							// a disposed texture next frame.
							if (this.scene && this.scene.environment === oldest) {
								this.scene.environment = null;
							}
							if (this.scene && this.scene.background === oldest) {
								this.scene.background = this.backgroundColor;
							}
							oldest.dispose();
						}
					}

					if (hasProgressUI) app.hideSpinner();
					resolve({ envMap });
				},
				(xhr) => {
					if (!hasProgressUI) return;
					const loaded = (xhr && xhr.loaded) || 0;
					const total = (xhr && xhr.total) || 0;
					app.updateProgress({ loaded, total });
				},
				(err) => {
					if (hasProgressUI) app.hideSpinner();
					reject(err);
				},
			);
		});
	}

	_buildGroundGridTexture() {
		if (this._groundTexture) return this._groundTexture;
		const res = 512;
		const canvas = document.createElement('canvas');
		canvas.width = res;
		canvas.height = res;
		const ctx = canvas.getContext('2d');

		// Solid dark base.
		ctx.fillStyle = '#0a0a0a';
		ctx.fillRect(0, 0, res, res);

		// 1px hairline grid lines every 32px.
		ctx.strokeStyle = '#1a1a1a';
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let i = 0; i <= res; i += 32) {
			const p = i + 0.5; // crisp 1px lines
			ctx.moveTo(p, 0);
			ctx.lineTo(p, res);
			ctx.moveTo(0, p);
			ctx.lineTo(res, p);
		}
		ctx.stroke();

		// Bolder 2px lines every 128px.
		ctx.strokeStyle = '#2a2a2a';
		ctx.lineWidth = 2;
		ctx.beginPath();
		for (let i = 0; i <= res; i += 128) {
			ctx.moveTo(i, 0);
			ctx.lineTo(i, res);
			ctx.moveTo(0, i);
			ctx.lineTo(res, i);
		}
		ctx.stroke();

		const tex = new CanvasTexture(canvas);
		tex.wrapS = RepeatWrapping;
		tex.wrapT = RepeatWrapping;
		tex.anisotropy = 8;
		this._groundTexture = tex;
		return tex;
	}

	_buildGroundAlphaTexture() {
		if (this._groundAlphaTexture) return this._groundAlphaTexture;
		const res = 512;
		const canvas = document.createElement('canvas');
		canvas.width = res;
		canvas.height = res;
		const ctx = canvas.getContext('2d');

		// Radial gradient: opaque center -> fully transparent at edges.
		const cx = res / 2;
		const cy = res / 2;
		const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, res / 2);
		gradient.addColorStop(0.0, 'rgba(255,255,255,1)');
		gradient.addColorStop(0.55, 'rgba(255,255,255,0.85)');
		gradient.addColorStop(1.0, 'rgba(0,0,0,0)');
		ctx.fillStyle = gradient;
		ctx.fillRect(0, 0, res, res);

		const tex = new CanvasTexture(canvas);
		// No tiling on alpha mask -- single full-plane vignette.
		tex.wrapS = RepeatWrapping;
		tex.wrapT = RepeatWrapping;
		tex.repeat.set(1, 1);
		this._groundAlphaTexture = tex;
		return tex;
	}

	_updateGround() {
		// Tear down any existing ground artifacts first.
		if (this.groundPlane) {
			this.scene.remove(this.groundPlane);
			this.groundPlane.geometry.dispose();
			this.groundPlane.material.dispose();
			this.groundPlane = null;
		}
		if (this.groundRing) {
			this.scene.remove(this.groundRing);
			this.groundRing.geometry.dispose();
			this.groundRing.material.dispose();
			this.groundRing = null;
		}

		if (!this.state.ground) return;

		const size = this._modelSize || new Vector3(1, 1, 1);
		const extent = Math.max(size.x, size.z, 0.1) * 4;

		// Main ground plane -- dark PBR surface with a procedural grid map and
		// a radial vignette alpha mask so edges fade into the background.
		const gridTex = this._buildGroundGridTexture();
		// One grid cell covers 8 world units, so tile based on plane size.
		gridTex.repeat.set(extent / 8, extent / 8);
		gridTex.needsUpdate = true;

		const alphaTex = this._buildGroundAlphaTexture();

		const planeGeo = new PlaneGeometry(extent, extent);
		const planeMat = new MeshStandardMaterial({
			color: 0x0a0a0a,
			roughness: 0.9,
			metalness: 0.0,
			map: gridTex,
			alphaMap: alphaTex,
			transparent: true,
			depthWrite: false,
			side: DoubleSide,
		});
		this.groundPlane = new Mesh(planeGeo, planeMat);
		this.groundPlane.rotation.x = -Math.PI / 2;
		this.groundPlane.position.y = 0;
		this.groundPlane.receiveShadow = true;
		this.groundPlane.renderOrder = -1;
		this.scene.add(this.groundPlane);

		// Amber halo ring just above the plane for a grounded, branded accent.
		const ringInner = Math.max(size.x, size.z) * 0.55;
		const ringOuter = ringInner * 1.04;
		const ringGeo = new RingGeometry(ringInner, ringOuter, 96);
		const accentHex = this.state && this.state.accent ? this.state.accent : '#FCB131';
		const ringMat = new MeshBasicMaterial({
			color: new Color(accentHex),
			transparent: true,
			opacity: 0.55,
			depthWrite: false,
			side: DoubleSide,
		});
		this.groundRing = new Mesh(ringGeo, ringMat);
		this.groundRing.rotation.x = -Math.PI / 2;
		this.groundRing.position.y = 0.001;
		this.scene.add(this.groundRing);
	}

	updateDisplay() {
		if (this.skeletonHelpers.length) {
			this.skeletonHelpers.forEach((helper) => this.scene.remove(helper));
		}

		traverseMaterials(this.content, (material) => {
			material.wireframe = this.state.wireframe;

			if (material instanceof PointsMaterial) {
				material.size = this.state.pointSize;
			}
		});

		this.content.traverse((node) => {
			if (node.geometry && node.skeleton && this.state.skeleton) {
				const helper = new SkeletonHelper(node.skeleton.bones[0].parent);
				helper.material.linewidth = 3;
				this.scene.add(helper);
				this.skeletonHelpers.push(helper);
			}
		});

		if (this.state.grid !== Boolean(this.gridHelper)) {
			if (this.state.grid) {
				this.gridHelper = new GridHelper();
				this.axesHelper = new AxesHelper();
				this.axesHelper.renderOrder = 999;
				this.axesHelper.onBeforeRender = (renderer) => renderer.clearDepth();
				this.scene.add(this.gridHelper);
				this.scene.add(this.axesHelper);
			} else {
				this.scene.remove(this.gridHelper);
				this.scene.remove(this.axesHelper);
				this.gridHelper = null;
				this.axesHelper = null;
				this.axesRenderer.clear();
			}
		}

		this.controls.autoRotate = this.state.autoRotate;
	}

	/**
	 * Runs common cleanups on the loaded glTF scene in-memory.
	 *
	 * Operates on the already-parsed three.js objects (not the raw glTF JSON),
	 * so no reload is required — changes take effect on the next frame.
	 *
	 * Fixes applied (when needed):
	 *   1. Recompute vertex normals for geometries missing or degenerate normals.
	 *   2. Replace NaN/Infinity vertex positions with 0.
	 *   3. Normalize each normal vec3 to unit length.
	 *   4. Sit the model on the floor (min.y of world AABB == 0).
	 *   5. Center the model on the XZ origin, preserving min.y == 0.
	 *   6. Recompute each geometry's bounding box and bounding sphere.
	 *   7. Ensure textures have flipY === false (the glTF spec default) and
	 *      force a re-upload with needsUpdate.
	 *
	 * @returns {void}
	 */
	_fixGLTF() {
		if (!this.content) {
			if (window.VIEWER && typeof window.VIEWER.toast === 'function') {
				window.VIEWER.toast('No model loaded.', { level: 'error' });
			}
			return;
		}

		const stats = {
			normalsRecomputed: 0,
			nansFound: 0,
			normalsNormalized: 0,
			repositioned: 0,
			boundsComputed: 0,
			texturesFixed: 0,
		};

		const seenGeometries = new Set();
		const seenTextures = new Set();

		// Helper: detect whether a normal attribute is "suspect" (zero-length
		// or wildly non-unit vectors). Spot-samples to stay O(n) on huge models.
		const hasSuspectNormals = (normalAttr) => {
			const count = normalAttr.count;
			if (!count) return true;
			const stride = Math.max(1, Math.floor(count / 64));
			let bad = 0;
			let checked = 0;
			for (let i = 0; i < count; i += stride) {
				const nx = normalAttr.getX(i);
				const ny = normalAttr.getY(i);
				const nz = normalAttr.getZ(i);
				const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
				checked++;
				if (!isFinite(len) || len < 0.5 || len > 1.5) bad++;
			}
			return checked > 0 && bad / checked > 0.1;
		};

		this.content.traverse((node) => {
			const geom = node.geometry;
			if (!geom || !geom.isBufferGeometry || seenGeometries.has(geom)) return;
			seenGeometries.add(geom);

			const position = geom.attributes && geom.attributes.position;
			const normal = geom.attributes && geom.attributes.normal;

			// 2. Remove NaN/Infinity vertices from position attribute.
			if (position) {
				const arr = position.array;
				let localNans = 0;
				for (let i = 0; i < arr.length; i++) {
					if (!isFinite(arr[i])) {
						arr[i] = 0;
						localNans++;
					}
				}
				if (localNans > 0) {
					position.needsUpdate = true;
					stats.nansFound += localNans;
					console.warn(
						`[FIX] Replaced ${localNans} non-finite position values on "${node.name || geom.uuid}"`,
					);
				}
			}

			// 1. Recompute normals if missing or clearly non-normalized.
			if (!normal || hasSuspectNormals(normal)) {
				if (position) {
					geom.computeVertexNormals();
					stats.normalsRecomputed++;
				}
			}

			// 3. Normalize each normal vec3 (re-read after possible recompute).
			const n2 = geom.attributes && geom.attributes.normal;
			if (n2) {
				let normalized = 0;
				for (let i = 0; i < n2.count; i++) {
					const x = n2.getX(i);
					const y = n2.getY(i);
					const z = n2.getZ(i);
					const len = Math.sqrt(x * x + y * y + z * z);
					if (len > 0 && Math.abs(len - 1) > 1e-4) {
						const inv = 1 / len;
						n2.setXYZ(i, x * inv, y * inv, z * inv);
						normalized++;
					}
				}
				if (normalized > 0) {
					n2.needsUpdate = true;
					stats.normalsNormalized += normalized;
				}
			}

			// 6. Recompute bounds (fixes raycasting/frustum-culling issues).
			geom.computeBoundingBox();
			geom.computeBoundingSphere();
			stats.boundsComputed++;
		});

		// 4 & 5. Sit-on-floor and center on origin XZ.
		// Use world-space AABB so nested transforms are accounted for.
		this.content.updateMatrixWorld(true);
		const box = new Box3().setFromObject(this.content);
		if (!box.isEmpty() && isFinite(box.min.x) && isFinite(box.max.x)) {
			const center = new Vector3();
			box.getCenter(center);
			const dx = -center.x;
			const dz = -center.z;
			const dy = -box.min.y;
			if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6 || Math.abs(dz) > 1e-6) {
				this.content.position.x += dx;
				this.content.position.y += dy;
				this.content.position.z += dz;
				stats.repositioned = 1;
			}
		}

		// 7. Normalize texture flipY per glTF spec (should be false).
		traverseMaterials(this.content, (material) => {
			for (const key in material) {
				const value = material[key];
				if (value && value.isTexture && !seenTextures.has(value)) {
					seenTextures.add(value);
					if (value.flipY !== false) {
						value.flipY = false;
						value.needsUpdate = true;
						stats.texturesFixed++;
					}
				}
			}
		});

		this.updateDisplay();

		const parts = [];
		if (stats.normalsRecomputed) parts.push(`${stats.normalsRecomputed} normals recomputed`);
		if (stats.nansFound) parts.push(`${stats.nansFound} NaNs cleaned`);
		if (stats.normalsNormalized) parts.push(`${stats.normalsNormalized} normals normalized`);
		if (stats.repositioned) parts.push('repositioned');
		if (stats.boundsComputed) parts.push(`${stats.boundsComputed} bounds rebuilt`);
		if (stats.texturesFixed) parts.push(`${stats.texturesFixed} textures refreshed`);
		const summary = parts.length ? parts.join(', ') : 'nothing to fix';

		if (window.VIEWER && typeof window.VIEWER.toast === 'function') {
			window.VIEWER.toast(`Fixed: ${summary}`, { level: 'success' });
		}
	}

	/**
	 * Export the current `this.content` Object3D as a self-contained .glb
	 * (binary glTF) and trigger a browser download. Whatever fixes or
	 * swapped-asset mutations are currently live in the scene graph get
	 * baked into the export — we re-serialize from the in-memory three.js
	 * tree, not from the original file bytes.
	 *
	 * Output filename is derived from the originally-loaded file (stored
	 * on `this._originalFilename` by app.js) with its extension replaced
	 * by .glb, falling back to "scene.glb".
	 */
	_exportGLB() {
		if (!this.content) {
			if (window.VIEWER && typeof window.VIEWER.toast === 'function') {
				window.VIEWER.toast('No model loaded.', { level: 'error' });
			}
			return;
		}

		const base =
			(this._originalFilename &&
				String(this._originalFilename).replace(/\.(gltf|glb)$/i, '')) ||
			'scene';
		const filename = `${base}.glb`;

		const onSuccess = (result) => {
			try {
				// For `binary: true` the result is an ArrayBuffer. Guard against
				// a JSON object in case any caller flips the option later.
				const blob =
					result instanceof ArrayBuffer
						? new Blob([result], { type: 'model/gltf-binary' })
						: new Blob([JSON.stringify(result)], { type: 'model/gltf+json' });

				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = filename;
				a.rel = 'noopener';
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
				// Release the object URL on the next frame so the browser has
				// had time to kick off the download.
				setTimeout(() => URL.revokeObjectURL(url), 0);

				const sizeKB = Math.max(1, Math.round(blob.size / 1024));
				if (window.VIEWER && typeof window.VIEWER.toast === 'function') {
					window.VIEWER.toast(`EXPORTED · ${filename} · ${sizeKB.toLocaleString()} KB`, {
						level: 'success',
					});
				}
			} catch (err) {
				console.error('[EXPORT] Failed to finalize .glb download:', err);
				if (window.VIEWER && typeof window.VIEWER.toast === 'function') {
					window.VIEWER.toast('EXPORT FAILED', { level: 'error' });
				}
			}
		};

		const onError = (error) => {
			console.error('[EXPORT] GLTFExporter failed:', error);
			if (window.VIEWER && typeof window.VIEWER.toast === 'function') {
				window.VIEWER.toast('EXPORT FAILED', { level: 'error' });
			}
		};

		try {
			const exporter = new GLTFExporter();
			exporter.parse(this.content, onSuccess, onError, {
				binary: true,
				embedImages: true,
				animations: this.clips || [],
			});
		} catch (err) {
			onError(err);
		}
	}

	updateBackground() {
		this.backgroundColor.set(this.state.bgColor);
	}

	/**
	 * Apply or revert FREE PAN overrides on OrbitControls. When on, panning is
	 * sensitized, damping is enabled, and the zoom cap is removed so the user
	 * can roam anywhere. When off, reset to the per-content defaults.
	 */
	_applyFreePan() {
		if (!this.controls) return;
		if (this.state.freePan) {
			this.controls.panSpeed = 2.0;
			this.controls.enableDamping = true;
			this.controls.dampingFactor = 0.08;
			this.controls.screenSpacePanning = true;
			this.controls.maxDistance = Infinity;
		} else {
			this.controls.panSpeed = 1.0;
			this.controls.enableDamping = false;
			this.controls.dampingFactor = 0.05;
			this.controls.maxDistance =
				typeof this._defaultMaxDistance === 'number' ? this._defaultMaxDistance : Infinity;
		}
	}

	/**
	 * Adds AxesHelper.
	 *
	 * See: https://stackoverflow.com/q/16226693/1314762
	 */
	addAxesHelper() {
		this.axesDiv = document.createElement('div');
		this.el.appendChild(this.axesDiv);
		this.axesDiv.classList.add('axes');

		const { clientWidth, clientHeight } = this.axesDiv;

		this.axesScene = new Scene();
		this.axesCamera = new PerspectiveCamera(50, clientWidth / clientHeight, 0.1, 10);
		this.axesScene.add(this.axesCamera);

		this.axesRenderer = new WebGLRenderer({ alpha: true });
		this.axesRenderer.setPixelRatio(window.devicePixelRatio);
		this.axesRenderer.setSize(this.axesDiv.clientWidth, this.axesDiv.clientHeight);

		this.axesCamera.up = this.defaultCamera.up;

		this.axesCorner = new AxesHelper(5);
		this.axesScene.add(this.axesCorner);
		this.axesDiv.appendChild(this.axesRenderer.domElement);
	}

	addGUI() {
		this.ui = {
			activeTab: 'map',
			activeRow: 0,
			tabsEl: document.getElementById('pm-tabs'),
			railEl: document.getElementById('pm-rail'),
			paneEl: document.getElementById('pm-pane'),
			actionsEl: document.getElementById('pm-actions'),
			menuAutoOpened: false,
		};
		this._buildSchema();
		this._renderTabs();
		this._renderRail();
		this._renderPane();
		this._wireGlobalUI();
		this._setAccent(this._readAccent());
		this._startMetaLoop();
	}

	_readAccent() {
		try {
			return localStorage.getItem('pm-accent') || 'amber';
		} catch (e) {
			return 'amber';
		}
	}

	_buildSchema() {
		const state = this.state;
		this.schema = this._wrapSchemaSetters({
			map: {
				label: 'MAP',
				rows: [
					{
						key: 'frame',
						label: 'Frame Model',
						type: 'camera-preset',
						preset: 'reset',
						icon: 'frame',
						desc: 'Reset the camera to frame the whole model.',
						run: () => this._cameraPreset('reset'),
					},
					{
						key: 'top',
						label: 'Top View',
						type: 'camera-preset',
						preset: 'top',
						icon: 'top',
						desc: 'Look straight down the Y axis.',
						run: () => this._cameraPreset('top'),
					},
					{
						key: 'front',
						label: 'Front View',
						type: 'camera-preset',
						preset: 'front',
						icon: 'front',
						desc: 'Look down the +Z axis.',
						run: () => this._cameraPreset('front'),
					},
					{
						key: 'side',
						label: 'Side View',
						type: 'camera-preset',
						preset: 'side',
						icon: 'side',
						desc: 'Look down the +X axis.',
						run: () => this._cameraPreset('side'),
					},
					{
						key: 'back',
						label: 'Back View',
						type: 'camera-preset',
						preset: 'back',
						icon: 'back',
						desc: 'Look down the -Z axis.',
						run: () => this._cameraPreset('back'),
					},
					{
						key: 'iso',
						label: 'Isometric',
						type: 'camera-preset',
						preset: 'iso',
						icon: 'iso',
						desc: 'Classic 3/4 isometric view.',
						run: () => this._cameraPreset('iso'),
					},
					{
						key: 'schematic',
						label: 'Schematic',
						type: 'map',
						view: 'overview',
						icon: 'schematic',
						desc: 'Top-down schematic of the loaded model. Your viewpoint is the red marker.',
					},
				],
			},
			brief: {
				label: 'BRIEF',
				rows: [
					{
						key: 'overview',
						label: 'Overview',
						type: 'brief',
						view: 'overview',
						desc: 'Hero stats: vertices, triangles, materials, textures, animations, file size.',
					},
					{
						key: 'metadata',
						label: 'Metadata',
						type: 'brief',
						view: 'metadata',
						desc: 'glTF asset info: generator, version, copyright, extensions used.',
					},
					{
						key: 'hierarchy',
						label: 'Hierarchy',
						type: 'brief',
						view: 'hierarchy',
						desc: 'Tree-style index of the first 30 nodes in the loaded scene.',
					},
					{
						key: 'materials',
						label: 'Materials',
						type: 'brief',
						view: 'materials',
						desc: 'Swatch grid of every material\u2019s base color.',
					},
					{
						key: 'autoFix',
						label: 'Auto-Fix Geometry',
						type: 'action',
						desc: 'Recompute normals, drop NaN vertices, rebuild bounds, sit on floor, center XZ, and refresh textures.',
						run: () => this._fixGLTF(),
					},
					{
						key: 'exportGlb',
						label: 'Download GLB',
						type: 'action',
						desc: 'Export the current scene (including any fixes or swapped assets) as a .glb file.',
						run: () => this._exportGLB(),
					},
				],
			},
			advanced: {
				label: 'ADVANCED',
				rows: [
					{
						key: 'adv-overview',
						label: 'Overview',
						type: 'asset-summary',
						desc: 'Per-asset inventory: images, textures, buffers, meshes, materials. Totals, savings, swap/replace.',
					},
					{
						key: 'adv-images',
						label: 'Images',
						type: 'asset',
						view: 'images',
						desc: 'Raw image resources (PNG/JPEG/KTX2). Download the originals or replace them in-place.',
					},
					{
						key: 'adv-textures',
						label: 'Textures',
						type: 'asset',
						view: 'textures',
						desc: 'Three.js textures derived from images — sampler state, UV, anisotropy.',
					},
					{
						key: 'adv-buffers',
						label: 'Buffers',
						type: 'asset',
						view: 'buffers',
						desc: 'Binary buffers backing geometry, animation, and morph data.',
					},
					{
						key: 'adv-meshes',
						label: 'Meshes',
						type: 'asset',
						view: 'meshes',
						desc: 'Per-mesh vertex / triangle / primitive inventory.',
					},
					{
						key: 'adv-materials',
						label: 'Materials',
						type: 'asset',
						view: 'materials',
						desc: 'Every unique material in the scene with its texture map count.',
					},
				],
			},
			display: {
				label: 'DISPLAY',
				rows: [
					{
						key: 'background',
						label: 'Background',
						type: 'bool',
						desc: 'Render the environment map as the scene background.',
						get: () => state.background,
						set: (v) => {
							state.background = v;
							this.updateEnvironment();
						},
					},
					{
						key: 'autoRotate',
						label: 'Auto Rotate',
						type: 'bool',
						desc: 'Slowly spin the camera around the model.',
						get: () => state.autoRotate,
						set: (v) => {
							state.autoRotate = v;
							this.updateDisplay();
						},
					},
					{
						key: 'followCamera',
						label: 'Follow Camera',
						type: 'bool',
						desc: 'Camera tracks the model as it animates.',
						get: () => state.followCamera,
						set: (v) => {
							state.followCamera = v;
						},
					},
					{
						key: 'freePan',
						label: 'Free Pan',
						type: 'bool',
						desc: 'Let the camera roam without a zoom cap.',
						get: () => state.freePan,
						set: (v) => {
							state.freePan = v;
							this._applyFreePan();
						},
					},
					{
						key: 'wireframe',
						label: 'Wireframe',
						type: 'bool',
						desc: 'Show the underlying geometry as lines.',
						get: () => state.wireframe,
						set: (v) => {
							state.wireframe = v;
							this.updateDisplay();
						},
					},
					{
						key: 'skeleton',
						label: 'Skeleton',
						type: 'bool',
						desc: 'Display animation bone joints overlaid on the model.',
						get: () => state.skeleton,
						set: (v) => {
							state.skeleton = v;
							this.updateDisplay();
						},
					},
					{
						key: 'grid',
						label: 'Grid',
						type: 'bool',
						desc: 'Show a floor grid for spatial reference.',
						get: () => state.grid,
						set: (v) => {
							state.grid = v;
							this.updateDisplay();
						},
					},
					{
						key: 'ground',
						label: 'Ground Plane',
						type: 'bool',
						desc: 'Add a subtle floor so the model does not float in mid-air.',
						get: () => state.ground,
						set: (v) => {
							state.ground = v;
							this._updateGround();
						},
					},
					{
						key: 'screenSpacePanning',
						label: 'Screen-Space Pan',
						type: 'bool',
						desc: 'Pan in screen units (vs world units).',
						get: () => this.controls.screenSpacePanning,
						set: (v) => {
							this.controls.screenSpacePanning = v;
						},
					},
					{
						key: 'pointSize',
						label: 'Point Size',
						type: 'num',
						min: 1,
						max: 16,
						step: 0.1,
						desc: 'Size of points for point-cloud models.',
						get: () => state.pointSize,
						set: (v) => {
							state.pointSize = v;
							this.updateDisplay();
						},
					},
					{
						key: 'bgColor',
						label: 'BG Color',
						type: 'color',
						desc: 'Flat background color when no environment is set.',
						get: () => state.bgColor,
						set: (v) => {
							state.bgColor = v;
							this.updateBackground();
						},
					},
				],
			},
			lighting: {
				label: 'LIGHTING',
				rows: [
					{
						key: 'environment',
						label: 'Environment',
						type: 'enum',
						options: environments.map((env) => env.name),
						desc: 'HDR skybox used for lighting and reflections.',
						get: () => state.environment,
						set: (v) => {
							state.environment = v;
							this.updateEnvironment();
						},
					},
					{
						key: 'toneMapping',
						label: 'Tone Mapping',
						type: 'enum',
						options: ['Linear', 'ACES Filmic'],
						values: [LinearToneMapping, ACESFilmicToneMapping],
						desc: 'How HDR brightness maps to screen. ACES is cinematic.',
						get: () =>
							state.toneMapping === ACESFilmicToneMapping ? 'ACES Filmic' : 'Linear',
						set: (v) => {
							state.toneMapping =
								v === 'ACES Filmic' ? ACESFilmicToneMapping : LinearToneMapping;
							this.updateLights();
						},
					},
					{
						key: 'exposure',
						label: 'Exposure',
						type: 'num',
						min: -10,
						max: 10,
						step: 0.01,
						desc: 'Overall brightness multiplier. Negative darkens, positive brightens.',
						get: () => state.exposure,
						set: (v) => {
							state.exposure = v;
							this.updateLights();
						},
					},
					{
						key: 'punctualLights',
						label: 'Punctual Lights',
						type: 'bool',
						desc: 'Enable extra ambient and directional lights when the model has none.',
						get: () => state.punctualLights,
						set: (v) => {
							state.punctualLights = v;
							this.updateLights();
						},
					},
					{
						key: 'ambientIntensity',
						label: 'Ambient Intensity',
						type: 'num',
						min: 0,
						max: 2,
						step: 0.01,
						desc: 'Overall base light hitting every surface equally.',
						get: () => state.ambientIntensity,
						set: (v) => {
							state.ambientIntensity = v;
							this.updateLights();
						},
					},
					{
						key: 'ambientColor',
						label: 'Ambient Color',
						type: 'color',
						desc: 'Tint of the base ambient light.',
						get: () => state.ambientColor,
						set: (v) => {
							state.ambientColor = v;
							this.updateLights();
						},
					},
					{
						key: 'directIntensity',
						label: 'Direct Intensity',
						type: 'num',
						min: 0,
						max: 4,
						step: 0.01,
						desc: 'Strength of the main directional (sun-like) light.',
						get: () => state.directIntensity,
						set: (v) => {
							state.directIntensity = v;
							this.updateLights();
						},
					},
					{
						key: 'directColor',
						label: 'Direct Color',
						type: 'color',
						desc: 'Color of the main directional light.',
						get: () => state.directColor,
						set: (v) => {
							state.directColor = v;
							this.updateLights();
						},
					},
					// --- Post-processing ---
					{
						key: 'bloom',
						label: 'Bloom',
						type: 'bool',
						desc: 'Soft glow around bright highlights (headlights, sun glints).',
						get: () => state.bloom,
						set: (v) => {
							state.bloom = v;
							this._updatePostProcessing();
						},
					},
					{
						key: 'bloomStrength',
						label: 'Bloom Strength',
						type: 'num',
						min: 0,
						max: 3,
						step: 0.01,
						desc: 'How bright the glow gets.',
						get: () => state.bloomStrength,
						set: (v) => {
							state.bloomStrength = v;
							this._updatePostProcessing();
						},
					},
					{
						key: 'bloomThreshold',
						label: 'Bloom Threshold',
						type: 'num',
						min: 0,
						max: 1,
						step: 0.01,
						desc: 'Brightness cutoff — only pixels above this bloom.',
						get: () => state.bloomThreshold,
						set: (v) => {
							state.bloomThreshold = v;
							this._updatePostProcessing();
						},
					},
					{
						key: 'bloomRadius',
						label: 'Bloom Radius',
						type: 'num',
						min: 0,
						max: 1,
						step: 0.01,
						desc: 'How far the glow spreads from bright pixels.',
						get: () => state.bloomRadius,
						set: (v) => {
							state.bloomRadius = v;
							this._updatePostProcessing();
						},
					},
					{
						key: 'ssao',
						label: 'SSAO',
						type: 'bool',
						desc: 'Screen-Space Ambient Occlusion. Adds contact shadows in creases.',
						get: () => state.ssao,
						set: (v) => {
							state.ssao = v;
							this._updatePostProcessing();
							// SSAO is a per-pixel depth-buffer pass and can
							// tank framerate on mobile GPUs. Warn the user
							// once per session when they flip it on.
							if (v && IS_MOBILE && !this._ssaoMobileWarned) {
								this._ssaoMobileWarned = true;
								if (window.VIEWER && typeof window.VIEWER.toast === 'function') {
									window.VIEWER.toast(
										'SSAO is expensive on mobile · expect lower framerate',
										{ level: 'info', duration: 4000 },
									);
								}
							}
						},
					},
					{
						key: 'ssaoStrength',
						label: 'SSAO Strength',
						type: 'num',
						min: 0,
						max: 2,
						step: 0.01,
						desc: 'Intensity of the creases.',
						get: () => state.ssaoStrength,
						set: (v) => {
							state.ssaoStrength = v;
							this._updatePostProcessing();
						},
					},
					{
						key: 'filmGrain',
						label: 'Film Grain',
						type: 'bool',
						desc: 'Subtle noise overlay for a cinematic feel.',
						get: () => state.filmGrain,
						set: (v) => {
							state.filmGrain = v;
							this._updatePostProcessing();
						},
					},
					{
						key: 'filmGrainIntensity',
						label: 'Grain Intensity',
						type: 'num',
						min: 0,
						max: 1,
						step: 0.01,
						desc: 'Amount of noise applied.',
						get: () => state.filmGrainIntensity,
						set: (v) => {
							state.filmGrainIntensity = v;
							this._updatePostProcessing();
						},
					},
				],
			},
			animation: { label: 'ANIMATION', rows: this._buildAnimRows() },
			morph: { label: 'MORPH', rows: this._buildMorphRows() },
			cameras: { label: 'CAMERAS', rows: this._buildCameraRows() },
		});
	}

	/**
	 * Wrap each row's `set(v)` so it also schedules a debounced URL sync.
	 * Keeps original behavior; URL encoding is best-effort and never throws.
	 */
	_wrapSchemaSetters(schema) {
		Object.values(schema).forEach((section) => {
			if (!section || !Array.isArray(section.rows)) return;
			section.rows.forEach((row) => {
				if (typeof row.set !== 'function') return;
				const origSet = row.set;
				row.set = (v) => {
					origSet(v);
					this._scheduleStateSyncToUrl();
				};
			});
		});
		return schema;
	}

	/**
	 * Debounced (300ms) encode of a minimal state subset into ?s=<base64>
	 * and push via history.replaceState so the address bar stays shareable.
	 */
	_scheduleStateSyncToUrl() {
		if (this._urlSyncTimer) clearTimeout(this._urlSyncTimer);
		this._urlSyncTimer = setTimeout(() => this._syncStateToUrl(), 300);
	}

	_syncStateToUrl() {
		try {
			const s = this.state;
			const payload = {
				environment: s.environment,
				background: s.background,
				autoRotate: s.autoRotate,
				wireframe: s.wireframe,
				grid: s.grid,
				toneMapping: s.toneMapping,
				exposure: s.exposure,
				ambientIntensity: s.ambientIntensity,
				directIntensity: s.directIntensity,
				bgColor: s.bgColor,
				pointSize: s.pointSize,
			};
			const encoded = this._encodeState(payload);
			const url = new URL(window.location.href);
			url.searchParams.set('s', encoded);
			window.history.replaceState(null, '', url.toString());
		} catch (e) {
			// Silent: URL sync is best-effort.
		}
	}

	/** Read ?s=... on load and overwrite matching state keys. */
	_applyStateFromUrl() {
		try {
			const params = new URLSearchParams(window.location.search || '');
			const encoded = params.get('s');
			if (!encoded) return;
			const payload = this._decodeState(encoded);
			if (!payload || typeof payload !== 'object') return;
			const allowed = [
				'environment',
				'background',
				'autoRotate',
				'wireframe',
				'grid',
				'toneMapping',
				'exposure',
				'ambientIntensity',
				'directIntensity',
				'bgColor',
				'pointSize',
			];
			allowed.forEach((k) => {
				if (Object.prototype.hasOwnProperty.call(payload, k)) {
					this.state[k] = payload[k];
				}
			});
			// Keep the cached backgroundColor Color in sync with restored bgColor.
			if (this.backgroundColor) this.backgroundColor.set(this.state.bgColor);
		} catch (e) {
			// Silent: bad share link shouldn't break the app.
		}
	}

	/** JSON -> URL-safe base64. */
	_encodeState(obj) {
		const json = JSON.stringify(obj);
		const b64 = btoa(json);
		return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	/** URL-safe base64 -> JSON. */
	_decodeState(encoded) {
		let b64 = String(encoded).replace(/-/g, '+').replace(/_/g, '/');
		const pad = b64.length % 4;
		if (pad) b64 += '='.repeat(4 - pad);
		const json = atob(b64);
		return JSON.parse(json);
	}

	_buildAnimRows() {
		const rows = [];
		if (!this.clips || !this.clips.length) return rows;
		rows.push({
			key: 'playAll',
			label: 'Play All',
			type: 'action',
			desc: 'Start all animation clips simultaneously.',
			run: () => this.playAllClips(),
		});
		rows.push({
			key: 'playbackSpeed',
			label: 'Playback Speed',
			type: 'num',
			min: 0,
			max: 1,
			step: 0.01,
			desc: 'Animation speed multiplier (1 = normal).',
			get: () => this.state.playbackSpeed,
			set: (v) => {
				this.state.playbackSpeed = v;
				if (this.mixer) this.mixer.timeScale = v;
			},
		});
		this.clips.forEach((clip) => {
			rows.push({
				key: `clip:${clip.name}`,
				label: clip.name,
				type: 'bool',
				desc: 'Play or pause this clip.',
				get: () => !!this.state.actionStates[clip.name],
				set: (v) => {
					this.state.actionStates[clip.name] = v;
					const action = this.mixer.clipAction(clip);
					action.setEffectiveTimeScale(1);
					v ? action.play() : action.stop();
				},
			});
		});
		return rows;
	}

	_buildMorphRows() {
		const rows = [];
		if (!this.content) return rows;
		this.content.traverse((mesh) => {
			if (!(mesh.geometry && mesh.morphTargetInfluences)) return;
			const dict = mesh.morphTargetDictionary || {};
			const influences = mesh.morphTargetInfluences;
			for (let i = 0; i < influences.length; i++) {
				let name = `morph_${i}`;
				for (const k in dict) {
					if (dict[k] === i && k) {
						name = k;
						break;
					}
				}
				rows.push({
					key: `morph:${mesh.name}:${i}`,
					label: `${mesh.name || 'mesh'} // ${name}`,
					type: 'num',
					min: 0,
					max: 1,
					step: 0.01,
					desc: 'Blend weight for this morph target (0 = off, 1 = full).',
					get: () => influences[i],
					set: (v) => {
						influences[i] = v;
					},
				});
			}
		});
		return rows;
	}

	_buildCameraRows() {
		const rows = [];
		if (!this.content) return rows;
		const names = [DEFAULT_CAMERA];
		this.content.traverse((n) => {
			if (n.isCamera) {
				n.name = n.name || `VIEWER__camera_${names.length}`;
				names.push(n.name);
			}
		});
		if (names.length > 1) {
			rows.push({
				key: 'camera',
				label: 'Active Camera',
				type: 'enum',
				options: names,
				desc: 'Switch between the default orbit camera and cameras embedded in the glTF.',
				get: () => this.state.camera,
				set: (v) => {
					this.state.camera = v;
					this.setCamera(v);
				},
			});
		}
		return rows;
	}

	_resetTab(tabKey) {
		if (!this._defaults) return;
		const groups = {
			display: {
				keys: [
					'background',
					'autoRotate',
					'followCamera',
					'freePan',
					'wireframe',
					'skeleton',
					'grid',
					'pointSize',
					'bgColor',
				],
				apply: () => {
					this.backgroundColor.set(this.state.bgColor);
					if (this.updateBackground) this.updateBackground();
					this.updateEnvironment();
					this.updateDisplay();
					this._applyFreePan();
				},
			},
			lighting: {
				keys: [
					'environment',
					'toneMapping',
					'exposure',
					'punctualLights',
					'ambientIntensity',
					'ambientColor',
					'directIntensity',
					'directColor',
				],
				apply: () => {
					this.updateEnvironment();
					this.updateLights();
				},
			},
			animation: {
				keys: ['playbackSpeed', 'actionStates'],
				apply: () => {
					if (this.mixer) this.mixer.timeScale = this.state.playbackSpeed;
					// Stop all clip actions so toggled-on clips return to the default (off) state.
					if (this.mixer && this.clips) {
						this.clips.forEach((clip) => {
							const action = this.mixer.clipAction(clip);
							if (!this.state.actionStates[clip.name]) action.stop();
						});
					}
				},
			},
		};
		const group = groups[tabKey];
		if (!group) return;
		group.keys.forEach((k) => {
			if (k in this._defaults) {
				// Deep-copy objects (e.g. actionStates) so edits don't mutate the snapshot.
				const v = this._defaults[k];
				this.state[k] = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
			}
		});
		group.apply();
		// Rebuild schema bindings (e.g. animation rows reflect actionStates) and re-render UI.
		this._buildSchema();
		this._renderRail();
		this._renderPane();
		const label = (this.schema[tabKey] && this.schema[tabKey].label) || tabKey.toUpperCase();
		if (window.VIEWER && typeof window.VIEWER.toast === 'function') {
			window.VIEWER.toast(`RESET · ${label}`, { level: 'info' });
		}
	}

	_renderTabs() {
		const tabsEl = this.ui.tabsEl;
		if (!tabsEl) return;
		tabsEl.innerHTML = '';
		Object.entries(this.schema).forEach(([key, section]) => {
			const btn = document.createElement('button');
			btn.className = 'pm__tab';
			btn.type = 'button';
			btn.setAttribute('role', 'tab');
			btn.dataset.tab = key;
			btn.setAttribute('aria-selected', key === this.ui.activeTab ? 'true' : 'false');
			btn.setAttribute('aria-label', `${section.label} section`);
			btn.textContent = section.label;
			btn.addEventListener('click', () => this._selectTab(key));
			tabsEl.appendChild(btn);
		});
	}

	_selectTab(key) {
		if (this.ui.activeTab === key) return;
		this.ui.activeTab = key;
		this.ui.activeRow = 0;
		this._renderTabs();
		this._renderRail();
		this._renderPane();
	}

	_renderRail() {
		const railEl = this.ui.railEl;
		if (!railEl) return;
		const section = this.schema[this.ui.activeTab];
		const rows = section.rows;
		const query = (this.ui.railQuery || '').trim().toLowerCase();
		railEl.innerHTML = '';

		// Search / filter input — sits above the rail title.
		const search = document.createElement('div');
		search.className = 'pm__search';
		const input = document.createElement('input');
		input.type = 'text';
		input.placeholder = 'FILTER...';
		input.setAttribute('aria-label', 'Filter settings');
		input.value = this.ui.railQuery || '';
		input.addEventListener('input', (e) => {
			this.ui.railQuery = e.target.value;
			this._applyRailFilter();
		});
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				if (this.ui.railQuery) {
					this.ui.railQuery = '';
					input.value = '';
					this._applyRailFilter();
				} else {
					input.blur();
				}
			}
		});
		search.appendChild(input);
		railEl.appendChild(search);
		this.ui.railSearchInput = input;

		const title = document.createElement('div');
		title.className = 'pm__rail-title';
		title.textContent = `${section.label} · ${rows.length}`;
		railEl.appendChild(title);

		if (!rows.length) {
			const empty = document.createElement('div');
			empty.className = 'pm__row';
			empty.innerHTML = `<span class="pm__row-label pm__empty">No ${section.label.toLowerCase()}</span>`;
			railEl.appendChild(empty);
			return;
		}

		rows.forEach((row, i) => {
			const btn = document.createElement('button');
			btn.className = 'pm__row';
			btn.type = 'button';
			btn.setAttribute('role', 'tab');
			btn.dataset.row = i;
			btn.dataset.label = String(row.label).toLowerCase();
			btn.setAttribute('aria-selected', i === this.ui.activeRow ? 'true' : 'false');
			btn.setAttribute(
				'aria-label',
				`${String(row.label).toUpperCase()} — ${this._formatValue(row) || 'open'}`,
			);
			btn.innerHTML = `<span class="pm__row-label"></span><span class="pm__row-value"></span>`;
			btn.querySelector('.pm__row-label').textContent = String(row.label).toUpperCase();
			const valueEl = btn.querySelector('.pm__row-value');
			if (row.icon) {
				valueEl.classList.add('pm__row-icon');
				valueEl.innerHTML = this._iconFor(row.icon);
			} else {
				valueEl.textContent = this._formatValue(row);
			}
			btn.addEventListener('click', () => this._selectRow(i));
			railEl.appendChild(btn);
		});

		// "No matches" helper — hidden unless the filter matches nothing.
		const noMatch = document.createElement('div');
		noMatch.className = 'pm__rail-nomatch';
		noMatch.textContent = 'No matches — clear filter or press ESC';
		noMatch.hidden = true;
		railEl.appendChild(noMatch);
		this.ui.railNoMatchEl = noMatch;

		if (query) this._applyRailFilter();
	}

	_applyRailFilter() {
		const railEl = this.ui.railEl;
		if (!railEl) return;
		const query = (this.ui.railQuery || '').trim().toLowerCase();
		const btns = railEl.querySelectorAll('.pm__row[data-row]');
		let visible = 0;
		btns.forEach((btn) => {
			const label = btn.dataset.label || '';
			const match = !query || label.includes(query);
			btn.style.display = match ? '' : 'none';
			if (match) visible++;
		});
		if (this.ui.railNoMatchEl) {
			this.ui.railNoMatchEl.hidden = !(query && visible === 0);
		}
	}

	_formatValue(row) {
		if (row.type === 'action') return '▶';
		if (row.type === 'camera-preset') return '▶';
		if (row.type === 'stats') return '';
		if (row.type === 'map') return '◉';
		if (row.type === 'brief') return '◆';
		if (row.type === 'asset' || row.type === 'asset-summary') return '◈';
		const v = row.get ? row.get() : '';
		if (row.type === 'bool') return v ? 'ON' : 'OFF';
		if (row.type === 'num')
			return typeof v === 'number' ? v.toFixed(2).replace(/\.00$/, '') : v;
		if (row.type === 'color') return String(v).toUpperCase();
		if (row.type === 'enum') return String(v).toUpperCase();
		return v;
	}

	/**
	 * Returns inline SVG markup for a camera-preset icon key.
	 * Icons use `currentColor` + 1.2px stroke so they inherit row color
	 * (dim → amber on hover → black when the row is selected/inverted).
	 */
	_iconFor(key, size = 14) {
		const s = size;
		const sw = Math.max(1, (size / 14) * 1.2);
		const common = `width="${s}" height="${s}" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"`;
		switch (key) {
			case 'frame':
				// Solid cube inside a dashed bounding rectangle.
				return `<svg ${common}>
					<rect x="1" y="1" width="12" height="12" stroke-dasharray="1.5 1.2" opacity="0.7"/>
					<rect x="4" y="4" width="6" height="6"/>
				</svg>`;
			case 'top':
				// Square viewed from directly above + center "looking-down" dot.
				return `<svg ${common}>
					<rect x="2" y="2" width="10" height="10"/>
					<circle cx="7" cy="7" r="0.9" fill="currentColor" stroke="none"/>
				</svg>`;
			case 'front':
				// Rectangle + tiny XY indicator below.
				return `<svg ${common}>
					<rect x="2.5" y="1.5" width="9" height="8"/>
					<path d="M2.5 12 L4 12 M4.5 12 L6 12" opacity="0.85"/>
					<path d="M7 12 L8.5 12 M9 12 L10.5 12" opacity="0.55"/>
				</svg>`;
			case 'side':
				// Same rectangle but stroked on one vertical edge for "side".
				return `<svg ${common}>
					<rect x="2.5" y="1.5" width="9" height="8"/>
					<line x1="2.5" y1="1.5" x2="2.5" y2="9.5" stroke-width="${sw * 1.6}"/>
					<path d="M2.5 12 L4 12 M4.5 12 L6 12" opacity="0.55"/>
					<path d="M7 12 L8.5 12 M9 12 L10.5 12" opacity="0.85"/>
				</svg>`;
			case 'back':
				// Mirrored front: heavy right edge + small back-arrow.
				return `<svg ${common}>
					<rect x="2.5" y="1.5" width="9" height="8"/>
					<line x1="11.5" y1="1.5" x2="11.5" y2="9.5" stroke-width="${sw * 1.6}"/>
					<path d="M10 12 L7 12" />
					<path d="M8 11 L7 12 L8 13" />
				</svg>`;
			case 'iso':
				// Classic iso diamond showing three cube faces.
				return `<svg ${common}>
					<path d="M7 1.5 L12.5 4.75 L12.5 9.25 L7 12.5 L1.5 9.25 L1.5 4.75 Z"/>
					<path d="M7 1.5 L7 7"/>
					<path d="M7 7 L12.5 4.75"/>
					<path d="M7 7 L1.5 4.75"/>
					<path d="M7 7 L7 12.5" opacity="0.7"/>
				</svg>`;
			case 'schematic': {
				// 4x4 grid.
				const lines = [];
				for (let i = 0; i <= 4; i++) {
					const p = 1 + i * 3;
					lines.push(`<line x1="${p}" y1="1" x2="${p}" y2="13"/>`);
					lines.push(`<line x1="1" y1="${p}" x2="13" y2="${p}"/>`);
				}
				return `<svg ${common}>${lines.join('')}</svg>`;
			}
			default:
				return '';
		}
	}

	_selectRow(i) {
		this.ui.activeRow = i;
		const rows = this.ui.railEl.querySelectorAll('.pm__row');
		rows.forEach((el, idx) => el.setAttribute('aria-selected', idx === i ? 'true' : 'false'));
		this._renderPane();
		// Soft-apply camera presets as soon as the user picks one in the Map
		// rail — saves an extra click. The APPLY VIEW button in the right
		// pane is still there for keyboard-only flow / explicit re-trigger.
		try {
			const section = this.schema[this.ui.activeTab];
			const row = section && section.rows[i];
			if (
				row &&
				row.type === 'camera-preset' &&
				this.ui.activeTab === 'map' &&
				this.content &&
				typeof row.run === 'function'
			) {
				row.run();
			}
		} catch (e) {}
		// On mobile (fullscreen menu), the rail and pane stack vertically;
		// tapping a rail row should bring its editor pane into view so the
		// user doesn't have to manually scroll down to see what changed.
		if (window.matchMedia && window.matchMedia('(max-width: 899px)').matches) {
			const pane = this.ui.paneEl;
			if (pane && typeof pane.scrollIntoView === 'function') {
				try {
					pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
				} catch (e) {
					pane.scrollIntoView();
				}
			}
		}
	}

	_renderPane() {
		const paneEl = this.ui.paneEl;
		if (!paneEl) return;
		const section = this.schema[this.ui.activeTab];
		const row = section.rows[this.ui.activeRow];

		const inner = document.createElement('div');
		inner.className = 'pm__pane-inner';
		const tabKey = this.ui.activeTab;
		const canReset = tabKey === 'display' || tabKey === 'lighting' || tabKey === 'animation';
		if (!row) {
			const sectionLabel = section.label;
			inner.innerHTML = `
				<div class="pm__pane-title-row">
					<h2 class="pm__pane-title"></h2>
				</div>
				<p class="pm__pane-sub"></p>
				<p class="pm__empty"><em>No items yet.</em> Load a model to see ${sectionLabel.toLowerCase()} controls.</p>
			`;
			inner.querySelector('.pm__pane-title').textContent = sectionLabel;
			inner.querySelector('.pm__pane-sub').textContent = sectionLabel;
			paneEl.innerHTML = '';
			paneEl.appendChild(inner);
			this._renderContextActions();
			return;
		}

		const isMap = row.type === 'map';
		const isBrief = row.type === 'brief';
		const title = String(row.label).toUpperCase();
		inner.innerHTML = `
			<div class="pm__pane-title-row">
				<h2 class="pm__pane-title"></h2>
			</div>
			<p class="pm__pane-sub"></p>
			<div class="pm__editor" id="pm-editor"></div>
		`;
		inner.querySelector('.pm__pane-title').textContent = title;
		if (canReset) {
			const titleRow = inner.querySelector('.pm__pane-title-row');
			const resetBtn = document.createElement('button');
			resetBtn.type = 'button';
			resetBtn.className = 'pm__reset';
			resetBtn.textContent = 'RESET';
			resetBtn.setAttribute('aria-label', `Reset ${section.label} to defaults`);
			resetBtn.addEventListener('click', () => this._resetTab(tabKey));
			titleRow.appendChild(resetBtn);
		}
		inner.querySelector('.pm__pane-sub').textContent = section.label;

		paneEl.innerHTML = '';
		paneEl.appendChild(inner);
		this._renderEditor(row);
		this._renderContextActions();
	}

	/**
	 * Renders the GTA V-style contextual action bar at the bottom-right
	 * of the pause menu (`#pm-actions`). Actions reflect the currently
	 * selected row on the active tab, each pairing an uppercase label
	 * with a compact keyboard hint kbd. On mobile the kbd hides and the
	 * button itself becomes the tap target.
	 *
	 * Always includes BACK [ESC]. Row-type-specific actions layer on
	 * top (SELECT / TOGGLE / CHANGE / ADJUST / PICK / APPLY VIEW /
	 * REPLACE + DOWNLOAD). The last (primary) action gets the filled
	 * white-on-black treatment to mirror GTA V's confirm button.
	 */
	_renderContextActions() {
		const el = this.ui && this.ui.actionsEl;
		if (!el) return;
		const tabKey = this.ui.activeTab;
		const section = this.schema[tabKey];
		const row = section && section.rows[this.ui.activeRow];

		// Compute the action list for the current context. Ordering:
		// secondary actions first (left), primary confirm-style last
		// (right), then the universal BACK action. This matches the
		// GTA V footer where the anchor "BACK" sits on the far right.
		const actions = [];

		if (row) {
			switch (row.type) {
				case 'action':
					actions.push({
						label: 'SELECT',
						key: '\u21B5' /* ↵ */,
						primary: true,
						run: () => row.run && row.run(),
					});
					break;
				case 'camera-preset':
					// Map tab: camera-preset rows apply the view.
					actions.push({
						label: 'APPLY VIEW',
						key: '\u21B5',
						primary: true,
						run: () => row.run && row.run(),
					});
					break;
				case 'bool':
					actions.push({
						label: 'TOGGLE',
						key: '\u2190\u2192' /* ←→ */,
						primary: true,
						run: () => {
							row.set(!row.get());
							this._renderRail();
							this._renderPane();
						},
					});
					break;
				case 'enum':
					actions.push({
						label: 'CHANGE',
						key: '\u2190\u2192',
						primary: true,
						run: () => this._cycleEnum(row, 1),
					});
					break;
				case 'num':
					// No direct action; arrow keys adjust the value.
					actions.push({
						label: 'ADJUST',
						key: '\u2190\u2192',
						primary: false,
						run: null,
					});
					break;
				case 'color':
					actions.push({
						label: 'PICK',
						key: '\u21B5',
						primary: true,
						run: () => {
							const input = this.ui.paneEl
								? this.ui.paneEl.querySelector('.pm__color-input')
								: null;
							if (input) {
								input.focus();
								if (typeof input.click === 'function') input.click();
							}
						},
					});
					break;
				case 'asset':
					// Advanced tab asset rows — bulk REPLACE / DOWNLOAD
					// keybindings. Triggers the first visible button of
					// that kind in the pane for keyboard users.
					if (tabKey === 'advanced') {
						actions.push({
							label: 'REPLACE',
							key: 'R',
							primary: false,
							run: () => this._triggerFirstAssetBtn('replace'),
						});
						actions.push({
							label: 'DOWNLOAD',
							key: 'D',
							primary: true,
							run: () => this._triggerFirstAssetBtn('download'),
						});
					}
					break;
				case 'asset-summary':
				case 'brief':
				case 'map':
				case 'stats':
				default:
					/* No row-type action; BACK remains. */
					break;
			}
		}

		// Universal BACK action (far right — anchor of the GTA V footer).
		actions.push({
			label: 'BACK',
			key: 'ESC',
			primary: false,
			run: () => this._setMenuOpen(false),
		});

		// Render.
		el.innerHTML = '';
		actions.forEach((a, i) => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'pm__action' + (a.primary ? ' pm__action--primary' : '');
			btn.setAttribute('aria-label', `${a.label} (${a.key})`);
			if (!a.run) {
				btn.disabled = true;
				btn.setAttribute('aria-disabled', 'true');
			}
			btn.innerHTML =
				'<span class="pm__action-label"></span>' + '<kbd class="pm__action-key"></kbd>';
			btn.querySelector('.pm__action-label').textContent = a.label;
			btn.querySelector('.pm__action-key').textContent = a.key;
			if (a.run) {
				btn.addEventListener('click', (ev) => {
					ev.preventDefault();
					a.run();
				});
			}
			el.appendChild(btn);
		});
	}

	/**
	 * Advanced tab R/D keybinding helper. Locates the first REPLACE or
	 * DOWNLOAD button inside the current asset pane and clicks it.
	 * Silently no-ops if nothing is visible (e.g. summary view).
	 */
	_triggerFirstAssetBtn(kind) {
		const pane = this.ui && this.ui.paneEl;
		if (!pane) return;
		const btns = pane.querySelectorAll('.pm__asset-btn');
		const want = kind === 'replace' ? 'REPLACE' : 'DOWNLOAD';
		for (const b of btns) {
			if ((b.textContent || '').trim().toUpperCase().startsWith(want)) {
				b.click();
				return;
			}
		}
	}

	_renderEditor(row) {
		const editorEl = document.getElementById('pm-editor');
		if (!editorEl) return;
		editorEl.innerHTML = '';

		// Tear down any previous map ticker when the pane changes.
		if (this._mapTickerId) {
			cancelAnimationFrame(this._mapTickerId);
			this._mapTickerId = null;
		}

		const addDesc = () => {
			if (!row.desc) return;
			const d = document.createElement('p');
			d.className = 'pm__desc';
			d.textContent = row.desc;
			editorEl.appendChild(d);
		};

		const labelEl = document.createElement('div');
		labelEl.className = 'pm__editor-label';
		labelEl.textContent = 'CURRENT VALUE';
		const currentVal = document.createElement('div');
		currentVal.className = 'pm__editor-current';
		currentVal.textContent = this._formatValue(row);

		const rowLabel = String(row.label).toUpperCase();

		if (row.type === 'bool') {
			editorEl.appendChild(labelEl);
			editorEl.appendChild(currentVal);
			const btn = document.createElement('button');
			btn.className = 'pm__toggle-btn';
			btn.type = 'button';
			btn.textContent = row.get() ? 'DISABLE' : 'ENABLE';
			btn.setAttribute('aria-pressed', row.get() ? 'true' : 'false');
			btn.setAttribute('aria-label', `Toggle ${rowLabel}`);
			btn.addEventListener('click', () => {
				row.set(!row.get());
				btn.textContent = row.get() ? 'DISABLE' : 'ENABLE';
				btn.setAttribute('aria-pressed', row.get() ? 'true' : 'false');
				currentVal.textContent = this._formatValue(row);
				this._refreshRowValueOnly();
			});
			editorEl.appendChild(btn);
		} else if (row.type === 'num') {
			editorEl.appendChild(labelEl);
			editorEl.appendChild(currentVal);
			const wrap = document.createElement('div');
			wrap.className = 'pm__slider-wrap';
			const min = row.min ?? 0;
			const max = row.max ?? 1;
			const step = row.step ?? 0.01;
			wrap.innerHTML = `
				<span class="pm__slider-value"></span>
				<input class="pm__slider" type="range" />
				<span class="pm__slider-value"></span>
			`;
			const [minLabel, maxLabel] = wrap.querySelectorAll('.pm__slider-value');
			minLabel.textContent = min;
			maxLabel.textContent = max;
			const input = wrap.querySelector('input');
			input.min = min;
			input.max = max;
			input.step = step;
			input.value = row.get();
			input.setAttribute('aria-label', `${rowLabel} value`);
			input.addEventListener('input', (e) => {
				row.set(parseFloat(e.target.value));
				currentVal.textContent = this._formatValue(row);
				this._refreshRowValueOnly();
			});
			editorEl.appendChild(wrap);
		} else if (row.type === 'enum') {
			editorEl.appendChild(labelEl);
			editorEl.appendChild(currentVal);
			const options = row.options;
			const curIdx = options.indexOf(row.get());
			const arrowRow = document.createElement('div');
			arrowRow.className = 'pm__arrow-row';
			const prev = document.createElement('button');
			prev.type = 'button';
			prev.className = 'pm__arrow-btn';
			prev.textContent = '◀';
			prev.disabled = curIdx <= 0;
			prev.setAttribute('aria-label', `Previous ${rowLabel} option`);
			prev.addEventListener('click', () => this._cycleEnum(row, -1));
			const next = document.createElement('button');
			next.type = 'button';
			next.className = 'pm__arrow-btn';
			next.textContent = '▶';
			next.disabled = curIdx >= options.length - 1;
			next.setAttribute('aria-label', `Next ${rowLabel} option`);
			next.addEventListener('click', () => this._cycleEnum(row, 1));
			const middle = document.createElement('div');
			middle.style.flex = '1';
			middle.style.textAlign = 'center';
			const count = document.createElement('span');
			count.className = 'pm__slider-value';
			count.textContent = `${curIdx + 1} / ${options.length}`;
			middle.appendChild(count);
			arrowRow.appendChild(prev);
			arrowRow.appendChild(middle);
			arrowRow.appendChild(next);
			editorEl.appendChild(arrowRow);
		} else if (row.type === 'color') {
			editorEl.appendChild(labelEl);
			editorEl.appendChild(currentVal);
			const c = document.createElement('input');
			c.type = 'color';
			c.className = 'pm__color-input';
			c.value = row.get();
			c.setAttribute('aria-label', `${rowLabel} color`);
			c.addEventListener('input', (e) => {
				row.set(e.target.value);
				currentVal.textContent = this._formatValue(row);
				this._refreshRowValueOnly();
			});
			editorEl.appendChild(c);
		} else if (row.type === 'action') {
			if (row.icon) {
				const preview = document.createElement('div');
				preview.className = 'pm__icon-preview';
				preview.innerHTML = this._iconFor(row.icon, 40);
				preview.setAttribute('aria-hidden', 'true');
				editorEl.appendChild(preview);
			}
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'pm__action-btn';
			b.textContent = rowLabel;
			b.setAttribute('aria-label', `Run ${rowLabel}`);
			b.addEventListener('click', () => row.run && row.run());
			editorEl.appendChild(b);
		} else if (row.type === 'camera-preset') {
			this._renderMapPreview(editorEl, row);
		} else if (row.type === 'map') {
			this._renderMapPane(editorEl, row);
		} else if (row.type === 'brief') {
			this._renderBriefPane(editorEl, row);
		} else if (row.type === 'asset' || row.type === 'asset-summary') {
			this._renderAssetsPane(editorEl, row);
		} else if (row.type === 'stats') {
			editorEl.appendChild(labelEl);
			if (this.stats && this.stats.dom) {
				this.stats.dom.style.position = 'static';
				this.stats.dom.style.margin = '0 0 16px';
				editorEl.appendChild(this.stats.dom);
			}
		}

		addDesc();
	}

	/**
	 * Right-pane renderer for camera-preset rows in the Map tab.
	 * Shows: big preset icon, an iso-style diagram of the camera position
	 * relative to the model's bounding box, the box dimensions, the
	 * computed distance from model center to camera, and an APPLY VIEW
	 * button. Rows are soft-applied on selection (see `_selectRow`); this
	 * button is kept for keyboard users / explicit re-trigger.
	 */
	_renderMapPreview(editorEl, row) {
		const wrap = document.createElement('div');
		wrap.className = 'pm__map-preview';
		wrap.dataset.preset = row.preset || row.key;

		// 1) Big preset icon (80x80).
		if (row.icon) {
			const preview = document.createElement('div');
			preview.className = 'pm__icon-preview pm__icon-preview--lg';
			preview.innerHTML = this._iconFor(row.icon, 80);
			preview.setAttribute('aria-hidden', 'true');
			wrap.appendChild(preview);
		}

		// 2) Iso-style diagram of the camera relative to the bounding box.
		const diagram = this._buildPresetDiagram(row.preset || row.key);
		wrap.appendChild(diagram);

		// 3) Bounding-box dimensions (Width / Height / Depth), same stats
		// shown on the Schematic view.
		let box = null;
		const size = new Vector3();
		const center = new Vector3();
		if (this.content) {
			box = new Box3().setFromObject(this.content);
			box.getSize(size);
			box.getCenter(center);
		}
		const geom = { hasModel: !!box, box, size, center };

		const dims = document.createElement('div');
		dims.className = 'pm__map-dims';
		const f = (n) => this._fmtMap(n);
		[
			['Width', geom.hasModel ? f(size.x) : '—', 'x'],
			['Height', geom.hasModel ? f(size.y) : '—', 'y'],
			['Depth', geom.hasModel ? f(size.z) : '—', 'z'],
		].forEach(([label, value, axis]) => {
			const cell = document.createElement('div');
			cell.className = 'pm__map-dim';
			cell.dataset.axis = axis;
			cell.innerHTML =
				'<span class="pm__map-dim-label"></span>' +
				'<span class="pm__map-dim-value"></span>';
			cell.querySelector('.pm__map-dim-label').textContent = label.toUpperCase();
			cell.querySelector('.pm__map-dim-value').textContent = value;
			dims.appendChild(cell);
		});
		wrap.appendChild(dims);

		// 4) Distance from model center to the camera after the preset
		// is applied. Mirrors the math in `_cameraPreset`.
		const distance = geom.hasModel ? Math.max(size.x, size.y, size.z) * 1.8 || 1 : null;
		const dist = document.createElement('p');
		dist.className = 'pm__map-distance';
		dist.textContent = geom.hasModel
			? `Camera will move to ${f(distance)} units from model center.`
			: 'Load a model to preview this view.';
		wrap.appendChild(dist);

		// 5) Big APPLY VIEW button with [ENTER] hint.
		const applyBtn = document.createElement('button');
		applyBtn.type = 'button';
		applyBtn.className = 'pm__action-btn pm__map-apply';
		applyBtn.setAttribute('aria-label', `Apply ${String(row.label).toUpperCase()} camera view`);
		applyBtn.innerHTML =
			'<span class="pm__map-apply-label">APPLY VIEW</span>' +
			'<span class="pm__kbd">[ENTER]</span>';
		applyBtn.disabled = !geom.hasModel;
		applyBtn.addEventListener('click', () => row.run && row.run());
		wrap.appendChild(applyBtn);

		editorEl.appendChild(wrap);
	}

	/**
	 * Builds an inline SVG that shows the model bounding box as a shaded
	 * iso cube + a small camera glyph positioned according to the preset,
	 * with dashed sight-lines pointing to the box center.
	 */
	_buildPresetDiagram(preset) {
		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('class', 'pm__map-diagram');
		svg.setAttribute('viewBox', '0 0 240 160');
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', `Camera placement diagram for ${preset} view`);

		// Iso cube (projected), centered around (120, 82).
		// Axis vectors in screen space (unit = 32px along each world axis).
		const CX = 120;
		const CY = 82;
		const U = 32; // world unit in screen px
		// World axes → screen offsets (classic iso-ish projection).
		const ax = (wx, wy, wz) => ({
			x: CX + wx * U * 0.92 - wz * U * 0.92,
			y: CY - wy * U * 0.8 + wx * U * 0.45 + wz * U * 0.45,
		});

		// Bounding box world-space half extents (unit cube: ±1).
		const H = 1;
		const corners = {
			// lowercase letters by sign convention
			A: ax(-H, -H, -H),
			B: ax(H, -H, -H),
			C: ax(H, -H, H),
			D: ax(-H, -H, H),
			E: ax(-H, H, -H),
			F: ax(H, H, -H),
			G: ax(H, H, H),
			P: ax(-H, H, H),
		};
		const pt = (c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`;

		// Shaded faces: top (E F G P), right (B C G F), front (D C G P).
		const face = (pts, cls) => {
			const f = document.createElementNS(svgNS, 'polygon');
			f.setAttribute('points', pts.map(pt).join(' '));
			f.setAttribute('class', cls);
			svg.appendChild(f);
		};
		face(
			[corners.D, corners.C, corners.G, corners.P],
			'pm__map-diagram-face pm__map-diagram-face--front',
		);
		face(
			[corners.B, corners.C, corners.G, corners.F],
			'pm__map-diagram-face pm__map-diagram-face--right',
		);
		face(
			[corners.E, corners.F, corners.G, corners.P],
			'pm__map-diagram-face pm__map-diagram-face--top',
		);

		// Back edges (dashed).
		const edge = (a, b, cls) => {
			const l = document.createElementNS(svgNS, 'line');
			l.setAttribute('x1', a.x);
			l.setAttribute('y1', a.y);
			l.setAttribute('x2', b.x);
			l.setAttribute('y2', b.y);
			l.setAttribute('class', cls);
			svg.appendChild(l);
		};
		edge(corners.A, corners.B, 'pm__map-diagram-edge pm__map-diagram-edge--hidden');
		edge(corners.A, corners.D, 'pm__map-diagram-edge pm__map-diagram-edge--hidden');
		edge(corners.A, corners.E, 'pm__map-diagram-edge pm__map-diagram-edge--hidden');

		// Box center (screen).
		const centerPt = ax(0, 0, 0);

		// Camera world-space position per preset (distance ~2.2 from center).
		const D = 2.4;
		const camWorld = (() => {
			switch (preset) {
				case 'top':
					return [0, D, 0];
				case 'front':
					return [0, 0, D];
				case 'back':
					return [0, 0, -D];
				case 'side':
					return [D, 0, 0];
				case 'iso':
					return [D * 0.7, D * 0.7, D * 0.7];
				case 'reset':
				default:
					return [D * 0.55, D * 0.35, D * 0.55];
			}
		})();
		const camPt = ax(camWorld[0], camWorld[1], camWorld[2]);

		// Dashed sight-line from camera to box center.
		const sight = document.createElementNS(svgNS, 'line');
		sight.setAttribute('x1', camPt.x);
		sight.setAttribute('y1', camPt.y);
		sight.setAttribute('x2', centerPt.x);
		sight.setAttribute('y2', centerPt.y);
		sight.setAttribute('class', 'pm__map-diagram-sight');
		svg.appendChild(sight);

		// Center dot (model origin marker).
		const centerDot = document.createElementNS(svgNS, 'circle');
		centerDot.setAttribute('cx', centerPt.x);
		centerDot.setAttribute('cy', centerPt.y);
		centerDot.setAttribute('r', 2.4);
		centerDot.setAttribute('class', 'pm__map-diagram-center');
		svg.appendChild(centerDot);

		// Camera glyph: small filled square + lens cone pointing at the center.
		const camG = document.createElementNS(svgNS, 'g');
		camG.setAttribute('class', 'pm__map-diagram-cam');
		const angle = Math.atan2(centerPt.y - camPt.y, centerPt.x - camPt.x);
		camG.setAttribute(
			'transform',
			`translate(${camPt.x.toFixed(1)}, ${camPt.y.toFixed(1)}) rotate(${(
				(angle * 180) /
				Math.PI
			).toFixed(1)})`,
		);
		const body = document.createElementNS(svgNS, 'rect');
		body.setAttribute('x', -8);
		body.setAttribute('y', -6);
		body.setAttribute('width', 12);
		body.setAttribute('height', 12);
		body.setAttribute('class', 'pm__map-diagram-cam-body');
		camG.appendChild(body);
		const lens = document.createElementNS(svgNS, 'polygon');
		lens.setAttribute('points', '4,-5 12,-8 12,8 4,5');
		lens.setAttribute('class', 'pm__map-diagram-cam-lens');
		camG.appendChild(lens);
		svg.appendChild(camG);

		// Axis legend in the lower-left corner so the viewer can orient
		// themselves (X red / Y green / Z amber — matches the rest of Map).
		const legendG = document.createElementNS(svgNS, 'g');
		legendG.setAttribute('class', 'pm__map-diagram-legend');
		legendG.setAttribute('transform', 'translate(18, 142)');
		const axisLine = (dx, dy, cls, label, lx, ly) => {
			const l = document.createElementNS(svgNS, 'line');
			l.setAttribute('x1', 0);
			l.setAttribute('y1', 0);
			l.setAttribute('x2', dx);
			l.setAttribute('y2', dy);
			l.setAttribute('class', cls);
			legendG.appendChild(l);
			const t = document.createElementNS(svgNS, 'text');
			t.setAttribute('x', lx);
			t.setAttribute('y', ly);
			t.setAttribute('class', cls + ' pm__map-diagram-legend-label');
			t.textContent = label;
			legendG.appendChild(t);
		};
		axisLine(14, 7, 'pm__map-diagram-axis pm__map-diagram-axis--x', '+X', 18, 12);
		axisLine(0, -14, 'pm__map-diagram-axis pm__map-diagram-axis--y', '+Y', 4, -16);
		axisLine(-14, 7, 'pm__map-diagram-axis pm__map-diagram-axis--z', '+Z', -26, 12);
		svg.appendChild(legendG);

		return svg;
	}

	_renderMapPane(editorEl, row) {
		const view = row.view || 'overview';

		let box = null;
		const size = new Vector3();
		const center = new Vector3();
		if (this.content) {
			box = new Box3().setFromObject(this.content);
			box.getSize(size);
			box.getCenter(center);
		}
		const geom = { hasModel: !!box, box, size, center };

		const wrap = document.createElement('div');
		wrap.className = 'pm__map';
		wrap.dataset.view = view;

		if (view === 'dimensions') this._renderMapDimensions(wrap, geom);
		else if (view === 'axes') this._renderMapAxes(wrap, geom);
		else if (view === 'center') this._renderMapCenter(wrap, geom);
		else this._renderMapOverview(wrap, geom);

		if (!geom.hasModel && view !== 'axes') {
			const empty = document.createElement('p');
			empty.className = 'pm__empty pm__map-empty';
			empty.innerHTML = '<em>No model loaded.</em>';
			wrap.appendChild(empty);
		}

		editorEl.appendChild(wrap);
	}

	_fmtMap(n) {
		if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
		return Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(3);
	}

	_buildMiniMapSVG(geom, opts = {}) {
		const { hasModel, box, size, center } = geom;
		const svgNS = 'http://www.w3.org/2000/svg';
		const VB = 400;
		const PAD = 40;
		const INNER = VB - PAD * 2;

		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('class', 'pm__map-svg');
		svg.setAttribute('viewBox', `0 0 ${VB} ${VB}`);
		svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', opts.ariaLabel || 'Top-down minimap of the loaded model');

		const frame = document.createElementNS(svgNS, 'rect');
		frame.setAttribute('x', PAD);
		frame.setAttribute('y', PAD);
		frame.setAttribute('width', INNER);
		frame.setAttribute('height', INNER);
		frame.setAttribute('class', 'pm__map-frame');
		svg.appendChild(frame);

		const grid = document.createElementNS(svgNS, 'g');
		grid.setAttribute('class', 'pm__map-grid');
		const DIVISIONS = 10;
		for (let i = 0; i <= DIVISIONS; i++) {
			const p = PAD + (INNER * i) / DIVISIONS;
			const v = document.createElementNS(svgNS, 'line');
			v.setAttribute('x1', p);
			v.setAttribute('y1', PAD);
			v.setAttribute('x2', p);
			v.setAttribute('y2', PAD + INNER);
			grid.appendChild(v);
			const h = document.createElementNS(svgNS, 'line');
			h.setAttribute('x1', PAD);
			h.setAttribute('y1', p);
			h.setAttribute('x2', PAD + INNER);
			h.setAttribute('y2', p);
			grid.appendChild(h);
		}
		svg.appendChild(grid);

		const axesG = document.createElementNS(svgNS, 'g');
		axesG.setAttribute('class', 'pm__map-axes');
		const hAxis = document.createElementNS(svgNS, 'line');
		hAxis.setAttribute('x1', PAD);
		hAxis.setAttribute('y1', VB / 2);
		hAxis.setAttribute('x2', PAD + INNER);
		hAxis.setAttribute('y2', VB / 2);
		axesG.appendChild(hAxis);
		const vAxis = document.createElementNS(svgNS, 'line');
		vAxis.setAttribute('x1', VB / 2);
		vAxis.setAttribute('y1', PAD);
		vAxis.setAttribute('x2', VB / 2);
		vAxis.setAttribute('y2', PAD + INNER);
		axesG.appendChild(vAxis);
		svg.appendChild(axesG);

		const labels = [
			['N', VB / 2, PAD - 14],
			['S', VB / 2, PAD + INNER + 22],
			['W', PAD - 16, VB / 2 + 4],
			['E', PAD + INNER + 16, VB / 2 + 4],
		];
		labels.forEach(([t, x, y]) => {
			const tx = document.createElementNS(svgNS, 'text');
			tx.setAttribute('class', 'pm__map-cardinal');
			tx.setAttribute('x', x);
			tx.setAttribute('y', y);
			tx.setAttribute('text-anchor', 'middle');
			tx.textContent = t;
			svg.appendChild(tx);
		});

		if (opts.showLegend !== false) {
			const legend = document.createElementNS(svgNS, 'g');
			legend.setAttribute('class', 'pm__map-legend');
			legend.setAttribute('transform', `translate(${PAD + 6}, ${PAD + INNER - 28})`);
			const legendBg = document.createElementNS(svgNS, 'rect');
			legendBg.setAttribute('x', 0);
			legendBg.setAttribute('y', 0);
			legendBg.setAttribute('width', 62);
			legendBg.setAttribute('height', 22);
			legendBg.setAttribute('class', 'pm__map-legend-bg');
			legend.appendChild(legendBg);
			const legendX = document.createElementNS(svgNS, 'text');
			legendX.setAttribute('x', 8);
			legendX.setAttribute('y', 15);
			legendX.setAttribute('class', 'pm__map-legend-x');
			legendX.textContent = '+X';
			legend.appendChild(legendX);
			const legendZ = document.createElementNS(svgNS, 'text');
			legendZ.setAttribute('x', 34);
			legendZ.setAttribute('y', 15);
			legendZ.setAttribute('class', 'pm__map-legend-z');
			legendZ.textContent = '+Z';
			legend.appendChild(legendZ);
			svg.appendChild(legend);
		}

		const rangeX = hasModel ? Math.max(size.x, 1e-6) : 1;
		const rangeZ = hasModel ? Math.max(size.z, 1e-6) : 1;
		const worldRange = Math.max(rangeX, rangeZ) * 1.4;
		const cx = hasModel ? center.x : 0;
		const cz = hasModel ? center.z : 0;
		const worldToSvgX = (wx) => VB / 2 + ((wx - cx) / worldRange) * INNER;
		const worldToSvgY = (wz) => VB / 2 + ((wz - cz) / worldRange) * INNER;
		const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

		if (hasModel && opts.showFootprint !== false) {
			const fx = worldToSvgX(box.min.x);
			const fz = worldToSvgY(box.min.z);
			const fx2 = worldToSvgX(box.max.x);
			const fz2 = worldToSvgY(box.max.z);
			const footprint = document.createElementNS(svgNS, 'rect');
			footprint.setAttribute('x', Math.min(fx, fx2));
			footprint.setAttribute('y', Math.min(fz, fz2));
			footprint.setAttribute('width', Math.abs(fx2 - fx));
			footprint.setAttribute('height', Math.abs(fz2 - fz));
			footprint.setAttribute('class', 'pm__map-footprint');
			svg.appendChild(footprint);
		}

		if (hasModel && opts.showCenter !== false) {
			if (opts.emphasizeCenter) {
				const ccx = worldToSvgX(cx);
				const ccy = worldToSvgY(cz);
				const L = 30;
				const mk = (x1, y1, x2, y2) => {
					const l = document.createElementNS(svgNS, 'line');
					l.setAttribute('x1', x1);
					l.setAttribute('y1', y1);
					l.setAttribute('x2', x2);
					l.setAttribute('y2', y2);
					l.setAttribute('class', 'pm__map-crosshair');
					svg.appendChild(l);
				};
				mk(ccx - L, ccy, ccx - 6, ccy);
				mk(ccx + 6, ccy, ccx + L, ccy);
				mk(ccx, ccy - L, ccx, ccy - 6);
				mk(ccx, ccy + 6, ccx, ccy + L);
			}
			const centerDot = document.createElementNS(svgNS, 'circle');
			centerDot.setAttribute('cx', worldToSvgX(cx));
			centerDot.setAttribute('cy', worldToSvgY(cz));
			centerDot.setAttribute('r', opts.emphasizeCenter ? 5 : 3);
			centerDot.setAttribute('class', 'pm__map-center');
			svg.appendChild(centerDot);
		}

		let camMarker = null;
		if (opts.showCamMarker !== false) {
			camMarker = document.createElementNS(svgNS, 'g');
			camMarker.setAttribute('class', 'pm__map-cam');
			const camHalo = document.createElementNS(svgNS, 'circle');
			camHalo.setAttribute('r', 9);
			camHalo.setAttribute('class', 'pm__map-cam-halo');
			camMarker.appendChild(camHalo);
			const camDot = document.createElementNS(svgNS, 'circle');
			camDot.setAttribute('r', 4);
			camDot.setAttribute('class', 'pm__map-cam-dot');
			camMarker.appendChild(camDot);
			const camHeading = document.createElementNS(svgNS, 'polygon');
			camHeading.setAttribute('points', '0,-14 5,-4 -5,-4');
			camHeading.setAttribute('class', 'pm__map-cam-heading');
			camMarker.appendChild(camHeading);
			svg.appendChild(camMarker);
		}

		const viewer = this;
		const startTicker = (onTick) => {
			const tmp = new Vector3();
			const tmpDir = new Vector3();
			const tick = () => {
				if (!svg.isConnected) {
					viewer._mapTickerId = null;
					return;
				}
				const cam = viewer.activeCamera || viewer.defaultCamera;
				cam.getWorldPosition(tmp);
				cam.getWorldDirection(tmpDir);
				const headingDeg = (Math.atan2(tmpDir.x, -tmpDir.z) * 180) / Math.PI;
				if (camMarker) {
					const px = clamp(worldToSvgX(tmp.x), PAD, PAD + INNER);
					const py = clamp(worldToSvgY(tmp.z), PAD, PAD + INNER);
					camMarker.setAttribute(
						'transform',
						`translate(${px}, ${py}) rotate(${headingDeg})`,
					);
				}
				if (onTick) onTick({ headingDeg, dir: tmpDir, pos: tmp });
				viewer._mapTickerId = requestAnimationFrame(tick);
			};
			viewer._mapTickerId = requestAnimationFrame(tick);
		};

		return { svg, startTicker };
	}

	_buildMapStats(geom, filter) {
		const { hasModel, size, center } = geom;
		const f = (n) => this._fmtMap(n);
		const all = hasModel
			? [
					['Width', f(size.x), 'x'],
					['Height', f(size.y), 'y'],
					['Depth', f(size.z), 'z'],
					['Center X', f(center.x), 'x'],
					['Center Y', f(center.y), 'y'],
					['Center Z', f(center.z), 'z'],
				]
			: [
					['Width', '—', 'x'],
					['Height', '—', 'y'],
					['Depth', '—', 'z'],
					['Center X', '—', 'x'],
					['Center Y', '—', 'y'],
					['Center Z', '—', 'z'],
				];
		const stats = filter === 'dim' ? all.slice(0, 3) : filter === 'center' ? all.slice(3) : all;
		const grid = document.createElement('div');
		grid.className = 'pm__map-stats';
		stats.forEach(([label, value, axis]) => {
			const cell = document.createElement('div');
			cell.className = 'pm__map-stat';
			cell.dataset.axis = axis;
			cell.innerHTML =
				'<span class="pm__map-stat-label"></span>' +
				'<span class="pm__map-stat-value"></span>';
			cell.querySelector('.pm__map-stat-label').textContent = label.toUpperCase();
			cell.querySelector('.pm__map-stat-value').textContent = value;
			grid.appendChild(cell);
		});
		return grid;
	}

	_renderMapOverview(wrap, geom) {
		const { svg, startTicker } = this._buildMiniMapSVG(geom, {
			showFootprint: true,
			showCenter: true,
			showCamMarker: true,
		});
		wrap.appendChild(svg);
		wrap.appendChild(this._buildMapStats(geom, 'all'));
		startTicker();
	}

	_renderMapDimensions(wrap, geom) {
		const { hasModel, size } = geom;
		const f = (n) => this._fmtMap(n);

		const maxDim = hasModel ? Math.max(size.x, size.y, size.z, 1e-6) : 1;

		const bars = document.createElement('div');
		bars.className = 'pm__map-bars';
		[
			['Width', hasModel ? size.x : 0, 'x'],
			['Height', hasModel ? size.y : 0, 'y'],
			['Depth', hasModel ? size.z : 0, 'z'],
		].forEach(([label, val, axis]) => {
			const row = document.createElement('div');
			row.className = 'pm__map-bar';
			row.dataset.axis = axis;
			const pct = hasModel ? Math.max(2, (val / maxDim) * 100) : 0;
			row.innerHTML =
				'<span class="pm__map-bar-label"></span>' +
				'<div class="pm__map-bar-track"><div class="pm__map-bar-fill"></div></div>' +
				'<span class="pm__map-bar-value"></span>';
			row.querySelector('.pm__map-bar-label').textContent = label.toUpperCase();
			row.querySelector('.pm__map-bar-fill').style.width = pct + '%';
			row.querySelector('.pm__map-bar-value').textContent = hasModel ? f(val) : '—';
			bars.appendChild(row);
		});
		wrap.appendChild(bars);

		if (hasModel) {
			const vol = size.x * size.y * size.z;
			const dims = [size.x, size.y, size.z];
			const longest = ['X', 'Y', 'Z'][dims.indexOf(maxDim)];
			const aspect = dims.map((d) => (d / maxDim).toFixed(2)).join(' : ');
			const summary = document.createElement('div');
			summary.className = 'pm__map-summary';
			summary.innerHTML =
				'<div class="pm__map-summary-item"><span class="pm__map-summary-label">VOLUME</span><span class="pm__map-summary-value" data-v="vol"></span></div>' +
				'<div class="pm__map-summary-item"><span class="pm__map-summary-label">LONGEST AXIS</span><span class="pm__map-summary-value" data-v="long"></span></div>' +
				'<div class="pm__map-summary-item"><span class="pm__map-summary-label">ASPECT X:Y:Z</span><span class="pm__map-summary-value" data-v="asp"></span></div>';
			summary.querySelector('[data-v="vol"]').textContent = f(vol);
			summary.querySelector('[data-v="long"]').textContent = longest;
			summary.querySelector('[data-v="asp"]').textContent = aspect;
			wrap.appendChild(summary);
		}
	}

	_renderMapAxes(wrap /*, geom */) {
		const svgNS = 'http://www.w3.org/2000/svg';
		const compass = document.createElementNS(svgNS, 'svg');
		compass.setAttribute('class', 'pm__map-svg pm__map-compass-svg');
		compass.setAttribute('viewBox', '0 0 400 400');
		compass.setAttribute('role', 'img');
		compass.setAttribute('aria-label', 'Live camera heading compass');

		const ring = document.createElementNS(svgNS, 'circle');
		ring.setAttribute('cx', 200);
		ring.setAttribute('cy', 200);
		ring.setAttribute('r', 160);
		ring.setAttribute('class', 'pm__map-compass-ring');
		compass.appendChild(ring);

		const ringInner = document.createElementNS(svgNS, 'circle');
		ringInner.setAttribute('cx', 200);
		ringInner.setAttribute('cy', 200);
		ringInner.setAttribute('r', 118);
		ringInner.setAttribute('class', 'pm__map-compass-ring-inner');
		compass.appendChild(ringInner);

		for (let deg = 0; deg < 360; deg += 15) {
			const rad = ((deg - 90) * Math.PI) / 180;
			const major = deg % 45 === 0;
			const outer = 160;
			const inner = major ? 138 : 150;
			const t = document.createElementNS(svgNS, 'line');
			t.setAttribute('x1', 200 + inner * Math.cos(rad));
			t.setAttribute('y1', 200 + inner * Math.sin(rad));
			t.setAttribute('x2', 200 + outer * Math.cos(rad));
			t.setAttribute('y2', 200 + outer * Math.sin(rad));
			t.setAttribute(
				'class',
				major ? 'pm__map-compass-tick pm__map-compass-tick--major' : 'pm__map-compass-tick',
			);
			compass.appendChild(t);
		}

		[
			['N', 200, 48],
			['E', 358, 205],
			['S', 200, 362],
			['W', 42, 205],
		].forEach(([t, x, y]) => {
			const tx = document.createElementNS(svgNS, 'text');
			tx.setAttribute('class', 'pm__map-cardinal pm__map-cardinal--big');
			tx.setAttribute('x', x);
			tx.setAttribute('y', y);
			tx.setAttribute('text-anchor', 'middle');
			tx.setAttribute('dominant-baseline', 'middle');
			tx.textContent = t;
			compass.appendChild(tx);
		});

		const axisG = (label, angleDeg, cls) => {
			const g = document.createElementNS(svgNS, 'g');
			g.setAttribute('transform', `translate(200, 200) rotate(${angleDeg})`);
			const line = document.createElementNS(svgNS, 'line');
			line.setAttribute('x1', 0);
			line.setAttribute('y1', 0);
			line.setAttribute('x2', 0);
			line.setAttribute('y2', -92);
			line.setAttribute('class', cls);
			g.appendChild(line);
			const tip = document.createElementNS(svgNS, 'polygon');
			tip.setAttribute('points', '0,-104 6,-90 -6,-90');
			tip.setAttribute('class', cls + ' pm__map-axis-tip');
			g.appendChild(tip);
			const lbl = document.createElementNS(svgNS, 'text');
			lbl.setAttribute('x', 0);
			lbl.setAttribute('y', -112);
			lbl.setAttribute('text-anchor', 'middle');
			lbl.setAttribute('class', cls + ' pm__map-axis-label');
			lbl.textContent = label;
			g.appendChild(lbl);
			return g;
		};
		// Three.js: +X is east (right), +Z is south (toward camera when looking at origin from +Z).
		compass.appendChild(axisG('+X', 90, 'pm__map-axis-x'));
		compass.appendChild(axisG('+Z', 180, 'pm__map-axis-z'));

		const pointer = document.createElementNS(svgNS, 'g');
		pointer.setAttribute('class', 'pm__map-compass-pointer');
		const p = document.createElementNS(svgNS, 'polygon');
		p.setAttribute('points', '0,-128 11,-96 0,-104 -11,-96');
		pointer.appendChild(p);
		compass.appendChild(pointer);

		wrap.appendChild(compass);

		const readout = document.createElement('div');
		readout.className = 'pm__map-summary';
		readout.innerHTML =
			'<div class="pm__map-summary-item"><span class="pm__map-summary-label">HEADING</span><span class="pm__map-summary-value" data-ro="heading">—</span></div>' +
			'<div class="pm__map-summary-item"><span class="pm__map-summary-label">FACING</span><span class="pm__map-summary-value" data-ro="facing">—</span></div>' +
			'<div class="pm__map-summary-item"><span class="pm__map-summary-label">PITCH</span><span class="pm__map-summary-value" data-ro="pitch">—</span></div>';
		wrap.appendChild(readout);
		const roHeading = readout.querySelector('[data-ro="heading"]');
		const roFacing = readout.querySelector('[data-ro="facing"]');
		const roPitch = readout.querySelector('[data-ro="pitch"]');

		const facingOf = (deg) => {
			const d = ((deg % 360) + 360) % 360;
			const cards = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
			return cards[Math.round(d / 45) % 8];
		};

		const tmpDir = new Vector3();
		const tick = () => {
			if (!compass.isConnected) {
				this._mapTickerId = null;
				return;
			}
			const cam = this.activeCamera || this.defaultCamera;
			cam.getWorldDirection(tmpDir);
			const headingDeg = (Math.atan2(tmpDir.x, -tmpDir.z) * 180) / Math.PI;
			pointer.setAttribute('transform', `rotate(${headingDeg})`);
			const clampedY = Math.max(-1, Math.min(1, -tmpDir.y));
			const pitchDeg = (Math.asin(clampedY) * 180) / Math.PI;
			const normDeg = ((headingDeg % 360) + 360) % 360;
			roHeading.textContent = normDeg.toFixed(0) + '°';
			roFacing.textContent = facingOf(normDeg);
			roPitch.textContent = pitchDeg.toFixed(0) + '°';
			this._mapTickerId = requestAnimationFrame(tick);
		};
		this._mapTickerId = requestAnimationFrame(tick);
	}

	_renderMapCenter(wrap, geom) {
		const { hasModel, center } = geom;
		const f = (n) => this._fmtMap(n);

		const { svg } = this._buildMiniMapSVG(geom, {
			showFootprint: true,
			showCenter: true,
			emphasizeCenter: true,
			showCamMarker: false,
			ariaLabel: 'Top-down map emphasizing model center',
		});
		wrap.appendChild(svg);

		const heroes = document.createElement('div');
		heroes.className = 'pm__map-heroes';
		[
			['Center X', hasModel ? f(center.x) : '—', 'x'],
			['Center Y', hasModel ? f(center.y) : '—', 'y'],
			['Center Z', hasModel ? f(center.z) : '—', 'z'],
		].forEach(([label, value, axis]) => {
			const h = document.createElement('div');
			h.className = 'pm__map-hero';
			h.dataset.axis = axis;
			h.innerHTML =
				'<span class="pm__map-hero-label"></span>' +
				'<span class="pm__map-hero-value"></span>';
			h.querySelector('.pm__map-hero-label').textContent = label.toUpperCase();
			h.querySelector('.pm__map-hero-value').textContent = value;
			heroes.appendChild(h);
		});
		wrap.appendChild(heroes);

		if (hasModel) {
			const mag = Math.sqrt(center.x ** 2 + center.y ** 2 + center.z ** 2);
			const centered = mag < 0.001;
			const summary = document.createElement('div');
			summary.className = 'pm__map-summary';
			summary.innerHTML =
				'<div class="pm__map-summary-item"><span class="pm__map-summary-label">OFFSET FROM ORIGIN</span><span class="pm__map-summary-value" data-v="mag"></span></div>' +
				'<div class="pm__map-summary-item"><span class="pm__map-summary-label">CENTERED</span><span class="pm__map-summary-value" data-v="ctr"></span></div>';
			summary.querySelector('[data-v="mag"]').textContent = f(mag);
			summary.querySelector('[data-v="ctr"]').textContent = centered ? 'YES' : 'NO';
			wrap.appendChild(summary);
		}
	}

	_cycleEnum(row, delta) {
		const options = row.options;
		const curIdx = options.indexOf(row.get());
		const n = Math.max(0, Math.min(options.length - 1, curIdx + delta));
		if (n !== curIdx) {
			row.set(options[n]);
			this._renderRail();
			this._renderPane();
		}
	}

	_collectBriefData() {
		const gltf = (typeof window !== 'undefined' && window.VIEWER && window.VIEWER.json) || null;
		const scene =
			(typeof window !== 'undefined' && window.VIEWER && window.VIEWER.scene) || this.content;

		let vertices = 0;
		let triangles = 0;
		const materialSet = new Set();
		const textureSet = new Set();
		const materials = [];
		const nodes = [];

		if (scene) {
			scene.traverse((node) => {
				if (node !== scene) {
					nodes.push({
						name: node.name || `<${node.type || 'Object3D'}>`,
						type: node.type || 'Object3D',
						depth: this._depthOf(node, scene),
					});
				}
				if (
					node.geometry &&
					node.geometry.attributes &&
					node.geometry.attributes.position
				) {
					const posCount = node.geometry.attributes.position.count || 0;
					vertices += posCount;
					if (node.geometry.index) {
						triangles += Math.floor(node.geometry.index.count / 3);
					} else {
						triangles += Math.floor(posCount / 3);
					}
				}
				const mats = Array.isArray(node.material)
					? node.material
					: node.material
						? [node.material]
						: [];
				mats.forEach((m) => {
					if (!m || materialSet.has(m.uuid)) return;
					materialSet.add(m.uuid);
					let hex = '#8C8C8C';
					if (m.color && typeof m.color.getHexString === 'function') {
						hex = `#${m.color.getHexString().toUpperCase()}`;
					}
					materials.push({ name: m.name || m.type || 'Material', type: m.type, hex });
					for (const key in m) {
						const val = m[key];
						if (val && val.isTexture && !textureSet.has(val.uuid)) {
							textureSet.add(val.uuid);
						}
					}
				});
			});
		}

		const asset =
			(gltf && gltf.asset) ||
			(gltf && gltf.parser && gltf.parser.json && gltf.parser.json.asset) ||
			{};
		const rawJson = gltf && gltf.parser && gltf.parser.json;
		const extensionsUsed =
			(gltf && gltf.extensionsUsed) || (rawJson && rawJson.extensionsUsed) || [];
		const animations = (gltf && gltf.animations) || this.clips || [];

		let bytes = 0;
		try {
			if (rawJson && Array.isArray(rawJson.buffers)) {
				bytes = rawJson.buffers.reduce((sum, b) => sum + (b.byteLength || 0), 0);
			}
		} catch (e) {
			bytes = 0;
		}

		return {
			gltf,
			scene,
			stats: {
				vertices,
				triangles,
				materials: materialSet.size,
				textures: textureSet.size,
				animations: animations.length,
				bytes,
			},
			asset: {
				generator: asset.generator || '\u2014',
				version: asset.version || '\u2014',
				copyright: asset.copyright || '\u2014',
				extensions: extensionsUsed.length ? extensionsUsed.join(', ') : '\u2014',
			},
			nodes: nodes.slice(0, 30),
			nodeTotal: nodes.length,
			materials,
		};
	}

	_depthOf(node, root) {
		let d = 0;
		let cur = node;
		while (cur && cur.parent && cur !== root) {
			cur = cur.parent;
			d++;
		}
		return Math.max(0, d - 1);
	}

	_formatBytes(bytes) {
		if (!bytes || !isFinite(bytes)) return '\u2014';
		const units = ['B', 'KB', 'MB', 'GB'];
		let n = bytes;
		let i = 0;
		while (n >= 1024 && i < units.length - 1) {
			n /= 1024;
			i++;
		}
		return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
	}

	_renderBriefPane(editorEl, row) {
		editorEl.classList.add('pm__brief');
		const data = this._collectBriefData();
		const noModel = !data.scene;
		const view = (row && row.view) || 'overview';

		const shell = document.createElement('div');
		shell.className = 'pm__brief-shell';
		shell.setAttribute('data-view', view);

		if (noModel) {
			const empty = document.createElement('p');
			empty.className = 'pm__empty';
			empty.innerHTML = '<em>No items yet.</em> Load a glTF asset to see model details.';
			shell.appendChild(empty);
			editorEl.appendChild(shell);
			return;
		}

		const cols = document.createElement('div');
		cols.className = 'pm__brief-cols';

		const heroStats = [
			{ label: 'Vertices', value: data.stats.vertices.toLocaleString() },
			{ label: 'Triangles', value: data.stats.triangles.toLocaleString() },
			{ label: 'Materials', value: String(data.stats.materials) },
			{ label: 'Textures', value: String(data.stats.textures) },
			{ label: 'Animations', value: String(data.stats.animations) },
			{ label: 'File Size', value: this._formatBytes(data.stats.bytes) },
		];

		const left = document.createElement('div');
		left.className = 'pm__brief-col';
		left.setAttribute('data-section', 'hero');
		left.setAttribute('data-active', view === 'overview' ? 'true' : 'false');
		left.innerHTML = `<div class="pm__brief-col-title">HERO STATS</div>`;
		const heroGrid = document.createElement('div');
		heroGrid.className = 'pm__brief-hero-grid';
		heroStats.forEach(({ label, value }) => {
			const cell = document.createElement('div');
			cell.className = 'pm__brief-hero-cell';
			cell.innerHTML = `
				<span class="pm__brief-hero-label"></span>
				<span class="pm__brief-hero-value"></span>
			`;
			cell.querySelector('.pm__brief-hero-label').textContent = label.toUpperCase();
			cell.querySelector('.pm__brief-hero-value').textContent = value;
			heroGrid.appendChild(cell);
		});
		left.appendChild(heroGrid);
		cols.appendChild(left);

		const right = document.createElement('div');
		right.className = 'pm__brief-col';
		right.setAttribute('data-section', 'metadata');
		right.setAttribute('data-active', view === 'metadata' ? 'true' : 'false');
		right.innerHTML = `<div class="pm__brief-col-title">METADATA</div>`;
		const metaList = document.createElement('dl');
		metaList.className = 'pm__brief-meta';
		const metaRows = [
			['Generator', data.asset.generator],
			['Version', data.asset.version],
			['Copyright', data.asset.copyright],
			['Extensions', data.asset.extensions],
		];
		metaRows.forEach(([k, v]) => {
			const dt = document.createElement('dt');
			dt.textContent = String(k).toUpperCase();
			const dd = document.createElement('dd');
			dd.textContent = String(v);
			metaList.appendChild(dt);
			metaList.appendChild(dd);
		});
		right.appendChild(metaList);
		cols.appendChild(right);

		shell.appendChild(cols);

		const nodesSec = document.createElement('section');
		nodesSec.className = 'pm__brief-section';
		nodesSec.setAttribute('data-section', 'hierarchy');
		nodesSec.setAttribute('data-active', view === 'hierarchy' ? 'true' : 'false');
		nodesSec.innerHTML = `
			<div class="pm__brief-section-head">
				<span class="pm__brief-section-title">NODES</span>
				<span class="pm__brief-section-count"></span>
			</div>
		`;
		nodesSec.querySelector('.pm__brief-section-count').textContent =
			`${data.nodes.length} / ${data.nodeTotal}`;
		const tree = document.createElement('ul');
		tree.className = 'pm__brief-tree';
		data.nodes.forEach((n) => {
			const li = document.createElement('li');
			li.className = 'pm__brief-tree-item';
			li.style.setProperty('--indent', String(Math.min(n.depth, 8)));
			li.innerHTML = `
				<span class="pm__brief-tree-branch" aria-hidden="true"></span>
				<span class="pm__brief-tree-name"></span>
				<span class="pm__brief-tree-type"></span>
			`;
			li.querySelector('.pm__brief-tree-name').textContent = n.name;
			li.querySelector('.pm__brief-tree-type').textContent = n.type;
			tree.appendChild(li);
		});
		if (!data.nodes.length) {
			const li = document.createElement('li');
			li.className = 'pm__brief-tree-item pm__empty';
			li.textContent = 'No nodes in scene.';
			tree.appendChild(li);
		}
		nodesSec.appendChild(tree);
		shell.appendChild(nodesSec);

		const matsSec = document.createElement('section');
		matsSec.className = 'pm__brief-section';
		matsSec.setAttribute('data-section', 'materials');
		matsSec.setAttribute('data-active', view === 'materials' ? 'true' : 'false');
		matsSec.innerHTML = `
			<div class="pm__brief-section-head">
				<span class="pm__brief-section-title">MATERIALS</span>
				<span class="pm__brief-section-count"></span>
			</div>
		`;
		matsSec.querySelector('.pm__brief-section-count').textContent = String(
			data.materials.length,
		);
		const swatches = document.createElement('div');
		swatches.className = 'pm__brief-swatches';
		data.materials.forEach((m) => {
			const sw = document.createElement('div');
			sw.className = 'pm__brief-swatch';
			sw.innerHTML = `
				<span class="pm__brief-swatch-chip"></span>
				<span class="pm__brief-swatch-name"></span>
				<span class="pm__brief-swatch-hex"></span>
			`;
			sw.querySelector('.pm__brief-swatch-chip').style.background = m.hex;
			sw.querySelector('.pm__brief-swatch-name').textContent = m.name;
			sw.querySelector('.pm__brief-swatch-hex').textContent = m.hex;
			swatches.appendChild(sw);
		});
		if (!data.materials.length) {
			const empty = document.createElement('div');
			empty.className = 'pm__empty';
			empty.textContent = 'No materials.';
			swatches.appendChild(empty);
		}
		matsSec.appendChild(swatches);
		shell.appendChild(matsSec);

		editorEl.appendChild(shell);
	}

	// =============================================================
	// ADVANCED tab — per-asset inspector / swap
	// =============================================================

	/**
	 * Pull every raw asset we can from the loaded glTF parser and the
	 * three.js scene graph. Best-effort: missing fields show an em-dash.
	 */
	_collectAssets() {
		const gltf = (typeof window !== 'undefined' && window.VIEWER && window.VIEWER.json) || null;
		const scene =
			(typeof window !== 'undefined' && window.VIEWER && window.VIEWER.scene) || this.content;

		const out = {
			hasModel: !!(gltf && scene),
			gltf,
			scene,
			parser: gltf && gltf.parser,
			rawJson: (gltf && gltf.parser && gltf.parser.json) || null,
			images: [],
			textures: [],
			buffers: [],
			meshes: [],
			materials: [],
		};

		if (!out.hasModel) return out;

		const json = out.rawJson || {};

		// --- Images -------------------------------------------------
		const rawImages = Array.isArray(json.images) ? json.images : [];
		rawImages.forEach((img, i) => {
			let bytes = 0;
			let w = 0;
			let h = 0;
			let mime = img.mimeType || '';
			let previewUrl = null;

			const tex = this._findTextureForImageIndex(i);
			if (tex && tex.image) {
				const im = tex.image;
				w = im.naturalWidth || im.width || 0;
				h = im.naturalHeight || im.height || 0;
				if (im.src && typeof im.src === 'string') previewUrl = im.src;
			}

			if (typeof img.bufferView === 'number' && Array.isArray(json.bufferViews)) {
				const bv = json.bufferViews[img.bufferView];
				if (bv && typeof bv.byteLength === 'number') bytes = bv.byteLength;
			}
			if (!mime && img.uri && /\.jpe?g($|\?)/i.test(img.uri)) mime = 'image/jpeg';
			if (!mime && img.uri && /\.png($|\?)/i.test(img.uri)) mime = 'image/png';
			if (!mime) mime = 'image/png';

			if (this._swappedAssets && this._swappedAssets.has(i)) {
				const swap = this._swappedAssets.get(i);
				bytes = swap.bytes ? swap.bytes.byteLength : bytes;
				mime = swap.mime || mime;
			}

			out.images.push({
				index: i,
				name: img.name || (img.uri ? String(img.uri).split('/').pop() : `image_${i}`),
				mime,
				type: (mime.split('/').pop() || 'png').toUpperCase(),
				width: w,
				height: h,
				bytes,
				previewUrl,
				texture: tex,
				raw: img,
			});
		});

		// --- Textures (walk the scene) ------------------------------
		const seenTex = new Set();
		scene.traverse((node) => {
			const mats = Array.isArray(node.material)
				? node.material
				: node.material
					? [node.material]
					: [];
			mats.forEach((m) => {
				if (!m) return;
				for (const key in m) {
					const val = m[key];
					if (val && val.isTexture && !seenTex.has(val.uuid)) {
						seenTex.add(val.uuid);
						const im = val.image || {};
						out.textures.push({
							uuid: val.uuid,
							name: val.name || key,
							slot: key,
							texture: val,
							width: im.width || im.naturalWidth || 0,
							height: im.height || im.naturalHeight || 0,
							flipY: val.flipY,
							anisotropy: val.anisotropy,
						});
					}
				}
			});
		});

		// --- Buffers ------------------------------------------------
		const rawBuffers = Array.isArray(json.buffers) ? json.buffers : [];
		rawBuffers.forEach((b, i) => {
			out.buffers.push({
				index: i,
				name: b.name || (b.uri ? String(b.uri).split('/').pop() : `buffer_${i}.bin`),
				bytes: b.byteLength || 0,
				uri: b.uri || null,
				raw: b,
			});
		});

		// --- Meshes -------------------------------------------------
		const rawMeshes = Array.isArray(json.meshes) ? json.meshes : [];
		rawMeshes.forEach((m, i) => {
			let verts = 0;
			let tris = 0;
			const primitives = Array.isArray(m.primitives) ? m.primitives : [];
			primitives.forEach((p) => {
				const posIdx = p.attributes && p.attributes.POSITION;
				if (typeof posIdx === 'number' && Array.isArray(json.accessors)) {
					verts += (json.accessors[posIdx] && json.accessors[posIdx].count) || 0;
				}
				if (typeof p.indices === 'number' && Array.isArray(json.accessors)) {
					const idxCount =
						(json.accessors[p.indices] && json.accessors[p.indices].count) || 0;
					tris += Math.floor(idxCount / 3);
				}
			});
			out.meshes.push({
				index: i,
				name: m.name || `mesh_${i}`,
				primitives: primitives.length,
				verts,
				tris,
			});
		});

		// --- Materials ----------------------------------------------
		const rawMats = Array.isArray(json.materials) ? json.materials : [];
		rawMats.forEach((m, i) => {
			const pbr = m.pbrMetallicRoughness || {};
			const mapCount =
				(pbr.baseColorTexture ? 1 : 0) +
				(pbr.metallicRoughnessTexture ? 1 : 0) +
				(m.normalTexture ? 1 : 0) +
				(m.occlusionTexture ? 1 : 0) +
				(m.emissiveTexture ? 1 : 0);
			out.materials.push({
				index: i,
				name: m.name || `material_${i}`,
				mapCount,
				alphaMode: m.alphaMode || 'OPAQUE',
				doubleSided: !!m.doubleSided,
			});
		});

		return out;
	}

	_findTextureForImageIndex(imageIndex) {
		const gltf = (window.VIEWER && window.VIEWER.json) || null;
		if (!gltf) return null;
		const json = gltf.parser && gltf.parser.json;
		if (!json || !Array.isArray(json.textures)) return null;

		const texIdxsForImage = [];
		json.textures.forEach((t, ti) => {
			if (t && t.source === imageIndex) texIdxsForImage.push(ti);
		});
		if (!texIdxsForImage.length) return null;

		const scene = (window.VIEWER && window.VIEWER.scene) || this.content;
		if (!scene) return null;

		let found = null;
		let fallback = null;
		scene.traverse((node) => {
			if (found) return;
			const mats = Array.isArray(node.material)
				? node.material
				: node.material
					? [node.material]
					: [];
			mats.forEach((m) => {
				if (!m || found) return;
				for (const key in m) {
					const v = m[key];
					if (v && v.isTexture) {
						if (v.userData && v.userData.gltfTextureIndex != null) {
							if (texIdxsForImage.includes(v.userData.gltfTextureIndex)) {
								found = v;
								return;
							}
						}
						if (!fallback) fallback = v;
					}
				}
			});
		});
		return found || fallback;
	}

	_formatKB(bytes) {
		if (!bytes || !isFinite(bytes)) return '\u2014';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	}

	_estGpuBytes(w, h) {
		if (!w || !h) return 0;
		return Math.round(w * h * 5.33);
	}

	_suggestOptimization(img) {
		const { width: w, height: h, bytes, mime } = img;
		if (!w || !h) return null;
		const raw = w * h * 4;
		const estJpeg = Math.round(raw * 0.12);
		const estPng = Math.round(raw * 0.6);

		if (Math.max(w, h) >= 2048) {
			return { text: `Downsample to 1024\u00D71024: \u221275%`, pct: 75 };
		}

		const isPng = /png/i.test(mime);
		if (isPng && bytes > 0) {
			const saved = Math.max(0, bytes - estJpeg);
			const pct = Math.min(95, Math.round((saved / bytes) * 100));
			if (pct >= 15) return { text: `\u2212${pct}% as JPEG 85%`, pct };
		}
		if (isPng && !bytes) {
			const pct = Math.round(((estPng - estJpeg) / estPng) * 100);
			return { text: `\u2212${pct}% as JPEG 85%`, pct };
		}
		return null;
	}

	_renderAssetsPane(editorEl, row) {
		editorEl.classList.add('pm__adv');
		const data = this._collectAssets();
		const view = (row && row.view) || 'overview';

		const shell = document.createElement('div');
		shell.className = 'pm__adv-shell';
		shell.dataset.view = view;

		if (!data.hasModel) {
			const empty = document.createElement('p');
			empty.className = 'pm__empty';
			empty.innerHTML =
				'<em>No model loaded.</em> Drop a glTF/GLB onto the viewer to inspect and swap its assets.';
			shell.appendChild(empty);
			editorEl.appendChild(shell);
			return;
		}

		if (row.type === 'asset-summary') {
			this._renderAssetSummary(shell, data);
		} else if (view === 'images') {
			this._renderAssetGroup(shell, 'images', data.images);
		} else if (view === 'textures') {
			this._renderAssetGroup(shell, 'textures', data.textures);
		} else if (view === 'buffers') {
			this._renderAssetGroup(shell, 'buffers', data.buffers);
		} else if (view === 'meshes') {
			this._renderAssetGroup(shell, 'meshes', data.meshes);
		} else if (view === 'materials') {
			this._renderAssetGroup(shell, 'materials', data.materials);
		} else {
			this._renderAssetSummary(shell, data);
		}

		editorEl.appendChild(shell);
	}

	_renderAssetSummary(shell, data) {
		const imgBytes = data.images.reduce((s, i) => s + (i.bytes || 0), 0);
		const bufBytes = data.buffers.reduce((s, b) => s + (b.bytes || 0), 0);
		const gpuBytes = data.images.reduce((s, i) => s + this._estGpuBytes(i.width, i.height), 0);
		let saved = 0;
		let baseline = 0;
		data.images.forEach((img) => {
			baseline += img.bytes || 0;
			const hint = this._suggestOptimization(img);
			if (hint && img.bytes) saved += Math.round((img.bytes * hint.pct) / 100);
		});
		const savingsPct = baseline ? Math.round((saved / baseline) * 100) : 0;

		const cells = [
			{ label: 'Images', value: String(data.images.length) },
			{ label: 'Textures', value: String(data.textures.length) },
			{ label: 'Buffers', value: String(data.buffers.length) },
			{ label: 'Meshes', value: String(data.meshes.length) },
			{ label: 'Materials', value: String(data.materials.length) },
			{ label: 'Image Bytes', value: this._formatKB(imgBytes) },
			{ label: 'Buffer Bytes', value: this._formatKB(bufBytes) },
			{ label: 'Est. GPU Mem', value: this._formatKB(gpuBytes) },
		];

		const head = document.createElement('div');
		head.className = 'pm__adv-head';
		head.innerHTML = `
			<div class="pm__adv-head-left">
				<div class="pm__adv-eyebrow">ASSET INVENTORY</div>
				<div class="pm__adv-title">ALL RESOURCES</div>
			</div>
			<div class="pm__adv-head-right">
				<span class="pm__adv-savings-label">POTENTIAL SAVINGS</span>
				<span class="pm__asset-savings pm__asset-savings--big"></span>
			</div>
		`;
		head.querySelector('.pm__asset-savings').textContent = savingsPct
			? `\u2212${savingsPct}%`
			: '\u22120%';
		shell.appendChild(head);

		const grid = document.createElement('div');
		grid.className = 'pm__adv-summary-grid';
		cells.forEach((c) => {
			const cell = document.createElement('div');
			cell.className = 'pm__adv-summary-cell';
			cell.innerHTML = `
				<span class="pm__adv-summary-label"></span>
				<span class="pm__adv-summary-value"></span>
			`;
			cell.querySelector('.pm__adv-summary-label').textContent = c.label.toUpperCase();
			cell.querySelector('.pm__adv-summary-value').textContent = c.value;
			grid.appendChild(cell);
		});
		shell.appendChild(grid);

		const jump = document.createElement('div');
		jump.className = 'pm__adv-jump';
		[
			['Images', 'adv-images'],
			['Textures', 'adv-textures'],
			['Buffers', 'adv-buffers'],
			['Meshes', 'adv-meshes'],
			['Materials', 'adv-materials'],
		].forEach(([label, key]) => {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'pm__adv-jump-btn';
			b.textContent = label.toUpperCase();
			b.addEventListener('click', () => this._jumpToAdvRow(key));
			jump.appendChild(b);
		});
		shell.appendChild(jump);
	}

	_jumpToAdvRow(rowKey) {
		const rows = this.schema.advanced && this.schema.advanced.rows;
		if (!rows) return;
		const idx = rows.findIndex((r) => r.key === rowKey);
		if (idx < 0) return;
		this._selectRow(idx);
	}

	_renderAssetGroup(shell, groupKey, items) {
		const head = document.createElement('div');
		head.className = 'pm__adv-head';

		const groupLabel = groupKey.toUpperCase();
		const count = items.length;

		if (groupKey === 'images') {
			let saved = 0;
			let baseline = 0;
			items.forEach((img) => {
				baseline += img.bytes || 0;
				const hint = this._suggestOptimization(img);
				if (hint && img.bytes) saved += Math.round((img.bytes * hint.pct) / 100);
			});
			const pct = baseline ? Math.round((saved / baseline) * 100) : 0;
			head.innerHTML = `
				<div class="pm__adv-head-left">
					<div class="pm__adv-eyebrow">${count} ITEM${count === 1 ? '' : 'S'}</div>
					<div class="pm__adv-title">${groupLabel}</div>
				</div>
				<div class="pm__adv-head-right">
					<span class="pm__adv-savings-label">POTENTIAL SAVINGS</span>
					<span class="pm__asset-savings pm__asset-savings--big"></span>
				</div>
			`;
			head.querySelector('.pm__asset-savings').textContent = pct
				? `\u2212${pct}%`
				: '\u22120%';
		} else {
			head.innerHTML = `
				<div class="pm__adv-head-left">
					<div class="pm__adv-eyebrow">${count} ITEM${count === 1 ? '' : 'S'}</div>
					<div class="pm__adv-title">${groupLabel}</div>
				</div>
			`;
		}
		shell.appendChild(head);

		const list = document.createElement('div');
		list.className = 'pm__asset-list';

		if (!items.length) {
			const empty = document.createElement('div');
			empty.className = 'pm__empty pm__asset-empty';
			empty.textContent = `No ${groupLabel.toLowerCase()} in this model.`;
			list.appendChild(empty);
			shell.appendChild(list);
			return;
		}

		items.forEach((item) => {
			const rowEl = this._renderAssetRow(groupKey, item);
			list.appendChild(rowEl);
		});
		shell.appendChild(list);
	}

	_renderAssetRow(groupKey, item) {
		const rowEl = document.createElement('div');
		rowEl.className = 'pm__asset-row';
		rowEl.dataset.group = groupKey;

		const thumb = document.createElement('div');
		thumb.className = 'pm__asset-thumb';
		if (groupKey === 'images' && item.previewUrl) {
			const img = document.createElement('img');
			img.src = item.previewUrl;
			img.alt = '';
			img.loading = 'lazy';
			thumb.appendChild(img);
		} else if (
			groupKey === 'textures' &&
			item.texture &&
			item.texture.image &&
			item.texture.image.src
		) {
			const img = document.createElement('img');
			img.src = item.texture.image.src;
			img.alt = '';
			img.loading = 'lazy';
			thumb.appendChild(img);
		} else {
			const icon = document.createElement('span');
			icon.className = 'pm__asset-thumb-icon';
			icon.textContent =
				{
					images: 'IMG',
					textures: 'TEX',
					buffers: 'BIN',
					meshes: 'MSH',
					materials: 'MAT',
				}[groupKey] || '\u2014';
			thumb.appendChild(icon);
		}
		rowEl.appendChild(thumb);

		const meta = document.createElement('div');
		meta.className = 'pm__asset-meta';

		const makeLine = (label, value) => {
			const line = document.createElement('div');
			line.className = 'pm__asset-meta-line';
			line.innerHTML = `
				<span class="pm__asset-meta-label"></span>
				<span class="pm__asset-meta-value"></span>
			`;
			line.querySelector('.pm__asset-meta-label').textContent = String(label).toUpperCase();
			line.querySelector('.pm__asset-meta-value').textContent = value;
			return line;
		};

		const nameLine = document.createElement('div');
		nameLine.className = 'pm__asset-name';
		nameLine.textContent = String(item.name || '').toUpperCase();
		meta.appendChild(nameLine);

		const stats = document.createElement('div');
		stats.className = 'pm__asset-stats';

		if (groupKey === 'images') {
			stats.appendChild(makeLine('Type', item.type));
			stats.appendChild(
				makeLine('Size', `${item.width || '\u2014'} \u00D7 ${item.height || '\u2014'}`),
			);
			stats.appendChild(makeLine('Bytes', this._formatKB(item.bytes)));
			stats.appendChild(
				makeLine('GPU', this._formatKB(this._estGpuBytes(item.width, item.height))),
			);
			const hint = this._suggestOptimization(item);
			if (hint) {
				const line = document.createElement('div');
				line.className = 'pm__asset-meta-line';
				const label = document.createElement('span');
				label.className = 'pm__asset-meta-label';
				label.textContent = 'HINT';
				const savings = document.createElement('span');
				savings.className = 'pm__asset-savings';
				savings.textContent = hint.text;
				line.appendChild(label);
				line.appendChild(savings);
				stats.appendChild(line);
			}
		} else if (groupKey === 'textures') {
			stats.appendChild(makeLine('Slot', item.slot));
			stats.appendChild(
				makeLine('Size', `${item.width || '\u2014'} \u00D7 ${item.height || '\u2014'}`),
			);
			stats.appendChild(makeLine('Flip Y', item.flipY ? 'ON' : 'OFF'));
			stats.appendChild(makeLine('Aniso', String(item.anisotropy || 1)));
		} else if (groupKey === 'buffers') {
			stats.appendChild(makeLine('Type', 'BIN'));
			stats.appendChild(makeLine('Bytes', this._formatKB(item.bytes)));
			if (item.uri) stats.appendChild(makeLine('URI', item.uri));
		} else if (groupKey === 'meshes') {
			stats.appendChild(makeLine('Primitives', String(item.primitives)));
			stats.appendChild(makeLine('Verts', item.verts.toLocaleString()));
			stats.appendChild(makeLine('Tris', item.tris.toLocaleString()));
		} else if (groupKey === 'materials') {
			stats.appendChild(makeLine('Maps', String(item.mapCount)));
			stats.appendChild(makeLine('Alpha', item.alphaMode));
			stats.appendChild(makeLine('2-Sided', item.doubleSided ? 'YES' : 'NO'));
		}
		meta.appendChild(stats);
		rowEl.appendChild(meta);

		const actions = document.createElement('div');
		actions.className = 'pm__asset-actions';

		if (groupKey === 'images' || groupKey === 'buffers') {
			const dl = document.createElement('button');
			dl.type = 'button';
			dl.className = 'pm__asset-btn';
			dl.textContent = 'DOWNLOAD';
			dl.addEventListener('click', () => this._downloadAsset(groupKey, item));
			actions.appendChild(dl);
		}

		if (groupKey === 'images') {
			const rep = document.createElement('button');
			rep.type = 'button';
			rep.className = 'pm__asset-btn pm__asset-btn--primary';
			rep.textContent = 'REPLACE';
			rep.addEventListener('click', () => this._openReplacePicker(item));
			actions.appendChild(rep);

			const hint = this._suggestOptimization(item);
			if (hint) {
				const opt = document.createElement('button');
				opt.type = 'button';
				opt.className = 'pm__asset-btn pm__asset-btn--ghost';
				opt.textContent = 'OPTIMIZE';
				opt.addEventListener('click', () => this._optimizeImageInPlace(item));
				actions.appendChild(opt);
			}
		}
		rowEl.appendChild(actions);

		return rowEl;
	}

	async _downloadAsset(groupKey, item) {
		try {
			if (groupKey === 'images') {
				let bytes = null;
				let mime = item.mime || 'image/png';
				if (this._swappedAssets && this._swappedAssets.has(item.index)) {
					const swap = this._swappedAssets.get(item.index);
					bytes = swap.bytes;
					mime = swap.mime || mime;
				} else if (item.previewUrl) {
					const res = await fetch(item.previewUrl);
					bytes = await res.arrayBuffer();
					mime = res.headers.get('content-type') || mime;
				}
				if (!bytes) {
					if (window.VIEWER && window.VIEWER.toast) {
						window.VIEWER.toast('NO BYTES AVAILABLE', { level: 'error' });
					}
					return;
				}
				const ext = (mime.split('/').pop() || 'png').replace('jpeg', 'jpg');
				const filename = this._stripExt(item.name) + '.' + ext;
				this._triggerDownload(new Blob([bytes], { type: mime }), filename);
			} else if (groupKey === 'buffers') {
				const parser = window.VIEWER && window.VIEWER.json && window.VIEWER.json.parser;
				if (!parser || !parser.getDependency) {
					if (window.VIEWER && window.VIEWER.toast) {
						window.VIEWER.toast('PARSER UNAVAILABLE', { level: 'error' });
					}
					return;
				}
				const ab = await parser.getDependency('buffer', item.index);
				const filename = this._stripExt(item.name) + '.bin';
				this._triggerDownload(
					new Blob([ab], { type: 'application/octet-stream' }),
					filename,
				);
			}
			if (window.VIEWER && window.VIEWER.toast) {
				window.VIEWER.toast(`DOWNLOADED \u00B7 ${String(item.name).toUpperCase()}`, {
					level: 'success',
					duration: 1800,
				});
			}
		} catch (e) {
			console.error('[advanced] download failed', e);
			if (window.VIEWER && window.VIEWER.toast) {
				window.VIEWER.toast('DOWNLOAD FAILED', { level: 'error' });
			}
		}
	}

	_stripExt(name) {
		return String(name || 'asset').replace(/\.[a-z0-9]+$/i, '');
	}

	_triggerDownload(blob, filename) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(() => URL.revokeObjectURL(url), 4000);
	}

	_openReplacePicker(item) {
		let input = this._replaceInput;
		if (!input) {
			input = document.createElement('input');
			input.type = 'file';
			input.accept = 'image/*';
			input.style.position = 'fixed';
			input.style.left = '-10000px';
			input.style.top = '-10000px';
			input.style.opacity = '0';
			document.body.appendChild(input);
			this._replaceInput = input;
		}
		input.onchange = (e) => {
			const file = e.target.files && e.target.files[0];
			input.value = '';
			if (!file) return;
			this._handleReplaceFile(item, file);
		};
		input.click();
	}

	async _handleReplaceFile(item, file) {
		try {
			const buf = await file.arrayBuffer();
			const blobUrl = URL.createObjectURL(new Blob([buf], { type: file.type || item.mime }));

			const oldTex = item.texture || this._findTextureForImageIndex(item.index);
			const newTex = new Texture();
			const imgEl = new Image();
			imgEl.crossOrigin = 'anonymous';
			imgEl.onload = () => {
				newTex.image = imgEl;
				if (oldTex) {
					newTex.wrapS = oldTex.wrapS;
					newTex.wrapT = oldTex.wrapT;
					newTex.magFilter = oldTex.magFilter;
					newTex.minFilter = oldTex.minFilter;
					newTex.anisotropy = oldTex.anisotropy;
					newTex.flipY = oldTex.flipY;
					newTex.colorSpace = oldTex.colorSpace;
					newTex.generateMipmaps = oldTex.generateMipmaps;
					newTex.name = oldTex.name || file.name;
				}
				newTex.needsUpdate = true;

				// Swap across every material that referenced the old texture.
				let swapCount = 0;
				const scene = (window.VIEWER && window.VIEWER.scene) || this.content;
				if (scene && oldTex) {
					scene.traverse((node) => {
						const mats = Array.isArray(node.material)
							? node.material
							: node.material
								? [node.material]
								: [];
						mats.forEach((m) => {
							if (!m) return;
							for (const key in m) {
								if (m[key] === oldTex) {
									m[key] = newTex;
									m.needsUpdate = true;
									swapCount++;
								}
							}
						});
					});
				}

				if (!this._swappedAssets) this._swappedAssets = new Map();
				this._swappedAssets.set(item.index, {
					bytes: buf,
					mime: file.type || item.mime,
					filename: file.name,
				});

				if (window.VIEWER && window.VIEWER.toast) {
					window.VIEWER.toast(
						`ASSET REPLACED \u00B7 ${String(item.name).toUpperCase()}${swapCount ? ` (\u00D7${swapCount})` : ''}`,
						{ level: 'success', duration: 2400 },
					);
				}

				// Re-render the pane to reflect new bytes + thumbnail.
				this._renderPane();
			};
			imgEl.onerror = () => {
				URL.revokeObjectURL(blobUrl);
				if (window.VIEWER && window.VIEWER.toast) {
					window.VIEWER.toast('DECODE FAILED', { level: 'error' });
				}
			};
			imgEl.src = blobUrl;
		} catch (e) {
			console.error('[advanced] replace failed', e);
			if (window.VIEWER && window.VIEWER.toast) {
				window.VIEWER.toast('REPLACE FAILED', { level: 'error' });
			}
		}
	}

	async _optimizeImageInPlace(item) {
		try {
			if (!item.previewUrl) {
				if (window.VIEWER && window.VIEWER.toast) {
					window.VIEWER.toast('NO SOURCE BYTES', { level: 'error' });
				}
				return;
			}
			const imgEl = new Image();
			imgEl.crossOrigin = 'anonymous';
			imgEl.src = item.previewUrl;
			await new Promise((res, rej) => {
				imgEl.onload = res;
				imgEl.onerror = rej;
			});
			let w = imgEl.naturalWidth || imgEl.width;
			let h = imgEl.naturalHeight || imgEl.height;
			const maxDim = Math.max(w, h);
			if (maxDim > 1024) {
				const s = 1024 / maxDim;
				w = Math.round(w * s);
				h = Math.round(h * s);
			}
			const canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext('2d');
			ctx.drawImage(imgEl, 0, 0, w, h);
			const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
			if (!blob) {
				if (window.VIEWER && window.VIEWER.toast) {
					window.VIEWER.toast('OPTIMIZE FAILED', { level: 'error' });
				}
				return;
			}
			const file = new File([blob], this._stripExt(item.name) + '.jpg', {
				type: 'image/jpeg',
			});
			await this._handleReplaceFile(item, file);
		} catch (e) {
			console.error('[advanced] optimize failed', e);
			if (window.VIEWER && window.VIEWER.toast) {
				window.VIEWER.toast('OPTIMIZE FAILED', { level: 'error' });
			}
		}
	}

	_refreshRowValueOnly() {
		const row = this.schema[this.ui.activeTab].rows[this.ui.activeRow];
		const sel = `[data-row="${this.ui.activeRow}"] .pm__row-value`;
		const el = this.ui.railEl.querySelector(sel);
		if (!el || !row) return;
		if (row.icon) {
			// Row value slot hosts an inline SVG — keep it, just flash.
		} else {
			el.textContent = this._formatValue(row);
		}
		// Flash amber for 180ms then fade back.
		el.classList.remove('pm__row-value--flash');
		// Force reflow so re-adding the class restarts the transition.
		void el.offsetWidth;
		el.classList.add('pm__row-value--flash');
		if (this._rowFlashTimer) clearTimeout(this._rowFlashTimer);
		this._rowFlashTimer = setTimeout(() => {
			el.classList.remove('pm__row-value--flash');
			this._rowFlashTimer = null;
		}, 180);
	}

	_wireGlobalUI() {
		document.querySelectorAll('.pm__swatch').forEach((s) => {
			s.addEventListener('click', () => this._setAccent(s.dataset.accent));
		});
		const toggle = document.getElementById('pm-toggle');
		if (toggle) {
			toggle.addEventListener('click', () => this._setMenuOpen(true));
		}
		// Mobile close (X) button — ESC-equivalent for touch devices.
		const closeBtn = document.getElementById('pm-close');
		if (closeBtn && !closeBtn._wired) {
			closeBtn._wired = true;
			closeBtn.addEventListener('click', () => this._setMenuOpen(false));
		}
		const share = document.getElementById('pm-share');
		if (share && !share._wired) {
			share._wired = true;
			share.addEventListener('click', () => this._copyShareLink(share));
		}
		if (!this._keyHandler) {
			this._keyHandler = (e) => this._onKey(e);
			window.addEventListener('keydown', this._keyHandler);
		}
		this._wireTouchGestures();
	}

	/**
	 * Mobile-only touch gestures on the pause menu:
	 *   - Swipe-right > 80px on the `.pm` overlay closes the menu
	 *     (ESC equivalent; mobile has no hardware escape key).
	 *   - Horizontal swipe on the tab bar switches tabs (Tab/Shift+Tab
	 *     equivalent; mobile has no keyboard).
	 */
	_wireTouchGestures() {
		if (this._touchGesturesWired) return;
		this._touchGesturesWired = true;

		const pmEl = document.querySelector('.pm');
		const tabsEl = this.ui && this.ui.tabsEl;

		// ---------- Swipe-right-to-close on the overlay ----------
		if (pmEl) {
			let sx = 0,
				sy = 0,
				tracking = false;
			pmEl.addEventListener(
				'touchstart',
				(e) => {
					if (!e.touches || e.touches.length !== 1) {
						tracking = false;
						return;
					}
					// Don't hijack swipes that begin inside a horizontally scrollable
					// region (e.g., the tab bar — it has its own gesture handler).
					if (tabsEl && tabsEl.contains(e.target)) {
						tracking = false;
						return;
					}
					sx = e.touches[0].clientX;
					sy = e.touches[0].clientY;
					tracking = true;
				},
				{ passive: true },
			);
			pmEl.addEventListener(
				'touchend',
				(e) => {
					if (!tracking) return;
					tracking = false;
					const t = (e.changedTouches && e.changedTouches[0]) || null;
					if (!t) return;
					const dx = t.clientX - sx;
					const dy = t.clientY - sy;
					// Must be a dominant rightward gesture ( > 80px, |dy| < |dx|/2 ).
					if (dx > 80 && Math.abs(dy) < Math.abs(dx) * 0.6) {
						this._setMenuOpen(false);
					}
				},
				{ passive: true },
			);
		}

		// ---------- Horizontal swipe on the tab bar -> prev/next tab ----------
		if (tabsEl) {
			let sx = 0,
				sy = 0,
				tracking = false;
			tabsEl.addEventListener(
				'touchstart',
				(e) => {
					if (!e.touches || e.touches.length !== 1) {
						tracking = false;
						return;
					}
					sx = e.touches[0].clientX;
					sy = e.touches[0].clientY;
					tracking = true;
				},
				{ passive: true },
			);
			tabsEl.addEventListener(
				'touchend',
				(e) => {
					if (!tracking) return;
					tracking = false;
					const t = (e.changedTouches && e.changedTouches[0]) || null;
					if (!t) return;
					const dx = t.clientX - sx;
					const dy = t.clientY - sy;
					// Threshold smaller than overlay-close so it reads naturally.
					if (Math.abs(dx) < 48 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
					const tabs = Object.keys(this.schema || {});
					if (!tabs.length) return;
					const i = tabs.indexOf(this.ui.activeTab);
					// Swipe LEFT (dx < 0) -> next tab; swipe RIGHT -> previous.
					const n = dx < 0 ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length;
					this._selectTab(tabs[n]);
				},
				{ passive: true },
			);
		}
	}

	/**
	 * Copy the current URL (with `?s=<encoded>`) to clipboard. Flush the
	 * pending debounce first so the link always reflects the latest state.
	 */
	_copyShareLink(btn) {
		if (this._urlSyncTimer) {
			clearTimeout(this._urlSyncTimer);
			this._urlSyncTimer = null;
		}
		this._syncStateToUrl();
		const href = window.location.href;
		const showSuccess = () => {
			if (window.VIEWER && typeof window.VIEWER.toast === 'function') {
				window.VIEWER.toast('LINK COPIED', { level: 'success', duration: 2000 });
			}
			if (btn) {
				const orig = btn.dataset.origLabel || btn.textContent;
				btn.dataset.origLabel = orig;
				btn.classList.add('pm__share--copied');
				btn.textContent = 'LINK COPIED';
				clearTimeout(this._shareLabelTimer);
				this._shareLabelTimer = setTimeout(() => {
					btn.classList.remove('pm__share--copied');
					btn.textContent = orig;
				}, 1600);
			}
		};
		const showFailure = () => {
			if (window.VIEWER && typeof window.VIEWER.toast === 'function') {
				window.VIEWER.toast('COPY FAILED', { level: 'error', duration: 2400 });
			} else if (btn) {
				const orig = btn.dataset.origLabel || btn.textContent;
				btn.dataset.origLabel = orig;
				btn.textContent = 'COPY FAILED';
				clearTimeout(this._shareLabelTimer);
				this._shareLabelTimer = setTimeout(() => (btn.textContent = orig), 1600);
			}
		};
		try {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(href).then(showSuccess, () => {
					this._fallbackCopy(href) ? showSuccess() : showFailure();
				});
			} else {
				this._fallbackCopy(href) ? showSuccess() : showFailure();
			}
		} catch (e) {
			showFailure();
		}
	}

	_fallbackCopy(text) {
		try {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.setAttribute('readonly', '');
			ta.style.position = 'fixed';
			ta.style.top = '-1000px';
			document.body.appendChild(ta);
			ta.select();
			const ok = document.execCommand('copy');
			document.body.removeChild(ta);
			return ok;
		} catch (e) {
			return false;
		}
	}

	_setAccent(name) {
		document.body.dataset.accent = name;
		try {
			localStorage.setItem('pm-accent', name);
		} catch (e) {}
		document.querySelectorAll('.pm__swatch').forEach((s) => {
			s.setAttribute('aria-checked', s.dataset.accent === name ? 'true' : 'false');
		});
	}

	_setMenuOpen(open) {
		document.body.dataset.menuOpen = open ? 'true' : 'false';
		const toggle = document.getElementById('pm-toggle');
		if (toggle) toggle.hidden = !!open;
		// On narrow/mobile widths the menu takes the full viewport, so
		// OrbitControls touch events would fight the menu scroll/swipe
		// handlers. Disable controls whenever the menu is open AND the
		// viewport is fullscreen-mode (<900px). On wide split-view layouts
		// the canvas is still visible on the right, so we keep controls on.
		if (this.controls) {
			const fullscreenMenu = open && window.matchMedia('(max-width: 899px)').matches;
			// Respect the camera-driven disable: if an embedded glTF camera
			// is active we never want to force controls back on.
			const cameraDrivenOff =
				this.state && this.state.camera && this.state.camera !== DEFAULT_CAMERA;
			if (fullscreenMenu) {
				this.controls.enabled = false;
			} else if (!cameraDrivenOff) {
				this.controls.enabled = true;
			}
		}
		// Split-view: opening/closing the pause menu changes the visible
		// viewport size (menu occupies the left 60% on wide screens), so
		// the three.js renderer needs to re-measure its container. One
		// rAF after the DOM flag flip lets layout settle before we read
		// clientWidth/clientHeight in resize().
		if (typeof requestAnimationFrame === 'function') {
			requestAnimationFrame(() => {
				try {
					this.resize();
				} catch (e) {}
			});
		} else {
			try {
				this.resize();
			} catch (e) {}
		}
	}

	_onKey(e) {
		// Ignore all keyboard shortcuts (including Escape toggling the
		// pause menu) until a model has actually been loaded. Before
		// that, the user only sees the dropzone — there's no menu to
		// toggle and no navigation to perform.
		if (!document.body.classList.contains('has-model')) return;
		if (e.key === 'Escape') {
			const open = document.body.dataset.menuOpen === 'true';
			this._setMenuOpen(!open);
			e.preventDefault();
			return;
		}
		if (document.body.dataset.menuOpen !== 'true') return;
		const tag = (e.target && e.target.tagName) || '';
		if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;

		// Focus the rail search on `/` — standard power-user shortcut.
		if (e.key === '/') {
			if (this.ui.railSearchInput) {
				e.preventDefault();
				this.ui.railSearchInput.focus();
				this.ui.railSearchInput.select();
			}
			return;
		}

		const tabs = Object.keys(this.schema);
		const rows = this.schema[this.ui.activeTab].rows;

		if (e.key === 'ArrowDown') {
			if (!rows.length) return;
			e.preventDefault();
			this._selectRow((this.ui.activeRow + 1) % rows.length);
		} else if (e.key === 'ArrowUp') {
			if (!rows.length) return;
			e.preventDefault();
			this._selectRow((this.ui.activeRow - 1 + rows.length) % rows.length);
		} else if (e.key === 'Tab') {
			e.preventDefault();
			const i = tabs.indexOf(this.ui.activeTab);
			const n = e.shiftKey ? (i - 1 + tabs.length) % tabs.length : (i + 1) % tabs.length;
			this._selectTab(tabs[n]);
		} else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			const row = rows[this.ui.activeRow];
			if (!row) return;
			if (row.type === 'bool') {
				e.preventDefault();
				row.set(!row.get());
				this._renderRail();
				this._renderPane();
			} else if (row.type === 'num') {
				e.preventDefault();
				const step = row.step ?? 0.01;
				const range = (row.max ?? 1) - (row.min ?? 0);
				const d = (e.key === 'ArrowRight' ? 1 : -1) * Math.max(step, range / 100);
				const cur = row.get() || 0;
				const v = Math.max(row.min ?? 0, Math.min(row.max ?? 1, cur + d));
				row.set(v);
				this._renderRail();
				this._renderPane();
			} else if (row.type === 'enum') {
				e.preventDefault();
				this._cycleEnum(row, e.key === 'ArrowRight' ? 1 : -1);
			}
		} else if (e.key === 'Enter' || e.key === ' ') {
			const row = rows[this.ui.activeRow];
			if (!row) return;
			if (row.type === 'action' || row.type === 'camera-preset') {
				e.preventDefault();
				row.run && row.run();
			} else if (row.type === 'bool') {
				e.preventDefault();
				row.set(!row.get());
				this._renderRail();
				this._renderPane();
			} else if (row.type === 'color') {
				// PICK: open the native color input for the selected row.
				e.preventDefault();
				const input = this.ui.paneEl
					? this.ui.paneEl.querySelector('.pm__color-input')
					: null;
				if (input) {
					input.focus();
					if (typeof input.click === 'function') input.click();
				}
			}
		} else if (
			this.ui.activeTab === 'advanced' &&
			(e.key === 'r' || e.key === 'R' || e.key === 'd' || e.key === 'D')
		) {
			// Advanced tab R/D shortcuts — REPLACE / DOWNLOAD the first
			// visible asset in the current pane. Mirrors the footer action bar.
			const row = rows[this.ui.activeRow];
			if (!row || row.type !== 'asset') return;
			e.preventDefault();
			this._triggerFirstAssetBtn(e.key === 'r' || e.key === 'R' ? 'replace' : 'download');
		}
	}

	_startMetaLoop() {
		if (this._metaLoopStarted) return;
		this._metaLoopStarted = true;

		// Legacy pause-menu meta elements (kept in sync for back-compat if present).
		const fpsEl = document.getElementById('pm-fps');
		const trisEl = document.getElementById('pm-tris');
		const callsEl = document.getElementById('pm-calls');

		// Build the permanent top-right HUD (amber sparklines + tabular values).
		this._buildHud();

		// Rolling 60-frame buffers for sparklines.
		const BUF = 60;
		const buffers = {
			fps: new Float32Array(BUF),
			ms: new Float32Array(BUF),
			tris: new Float32Array(BUF),
			calls: new Float32Array(BUF),
			mem: new Float32Array(BUF),
			geo: new Float32Array(BUF),
			tex: new Float32Array(BUF),
		};
		this._hudBuffers = buffers;

		const push = (key, v) => {
			const b = buffers[key];
			b.copyWithin(0, 1);
			b[BUF - 1] = v;
		};

		// Per-frame FPS/ms: smoothed EMA of instantaneous 1000/dt, plus raw ms.
		let prev = performance.now();
		let fpsEma = 60;
		let lastDomUpdate = 0;
		// DOM write cadence: 2Hz (every 500ms) — keeps the readout legible and
		// avoids flickering digits. Rolling buffers are still sampled every
		// frame below, so sparklines stay accurate.
		const DOM_UPDATE_INTERVAL_MS = 500;

		const tick = (t) => {
			const dt = Math.max(0.5, t - prev);
			prev = t;
			const instFps = 1000 / dt;
			fpsEma = fpsEma + 0.1 * (instFps - fpsEma); // alpha ~ 0.1

			const info = this.renderer && this.renderer.info;
			const tri = info ? info.render.triangles : 0;
			const calls = info ? info.render.calls : 0;
			const geo = info ? info.memory.geometries : 0;
			const tex = info ? info.memory.textures : 0;
			const memMB =
				performance.memory && performance.memory.usedJSHeapSize
					? performance.memory.usedJSHeapSize / (1024 * 1024)
					: 0;

			// Sample every frame → accurate sparklines.
			push('fps', fpsEma);
			push('ms', dt);
			push('tris', tri);
			push('calls', calls);
			push('mem', memMB);
			push('geo', geo);
			push('tex', tex);

			// Throttle DOM text + sparkline redraws to 2Hz (every 500ms).
			if (t - lastDomUpdate >= DOM_UPDATE_INTERVAL_MS) {
				lastDomUpdate = t;
				const fpsRounded = Math.round(fpsEma);
				if (fpsEl) fpsEl.textContent = fpsRounded;
				if (trisEl) trisEl.textContent = tri.toLocaleString();
				if (callsEl) callsEl.textContent = calls;
				this._renderHud({
					fps: fpsRounded,
					ms: dt,
					tris: tri,
					calls,
					mem: memMB,
					geo,
					tex,
				});
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}

	_buildHud() {
		const hud = document.getElementById('hud');
		if (!hud || hud._built) return;
		hud._built = true;

		// Metric schema — order defines display order. Compact shows the first 3.
		const metrics = [
			{ key: 'fps', label: 'FPS' },
			{ key: 'ms', label: 'MS' },
			{ key: 'calls', label: 'CALLS' },
			{ key: 'tris', label: 'TRIS' },
			{ key: 'mem', label: 'MEM' },
			{ key: 'geo', label: 'GEO' },
			{ key: 'tex', label: 'TEX' },
		];

		const svgNS = 'http://www.w3.org/2000/svg';
		hud.innerHTML = '';
		metrics.forEach((m) => {
			const row = document.createElement('div');
			row.className = 'hud__row';
			row.dataset.metric = m.key;

			const label = document.createElement('span');
			label.className = 'hud__label';
			label.textContent = m.label;

			const value = document.createElement('span');
			value.className = 'hud__value';
			value.id = `hud-v-${m.key}`;
			value.textContent = '—';

			const svg = document.createElementNS(svgNS, 'svg');
			svg.setAttribute('class', 'hud__chart');
			svg.setAttribute('viewBox', '0 0 60 20');
			svg.setAttribute('preserveAspectRatio', 'none');
			svg.setAttribute('aria-hidden', 'true');
			const fill = document.createElementNS(svgNS, 'path');
			fill.setAttribute('class', 'hud__chart-fill');
			fill.id = `hud-f-${m.key}`;
			const line = document.createElementNS(svgNS, 'path');
			line.setAttribute('class', 'hud__chart-line');
			line.id = `hud-p-${m.key}`;
			svg.appendChild(fill);
			svg.appendChild(line);

			row.appendChild(label);
			row.appendChild(value);
			row.appendChild(svg);
			hud.appendChild(row);
		});

		// Reveal the HUD node — actual visibility is CSS-gated by body.has-model.
		hud.hidden = false;
		hud.setAttribute('aria-hidden', 'false');
		hud.title = 'Click to expand / collapse';
		hud.tabIndex = 0;

		// Click (or Enter/Space) toggles compact <-> expanded.
		const toggle = () => {
			hud.classList.toggle('hud--expanded');
			if (this._hudBuffers) this._redrawSparklines();
		};
		hud.addEventListener('click', toggle);
		hud.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggle();
			}
		});
	}

	_renderHud(v) {
		const set = (id, text) => {
			const el = document.getElementById(id);
			if (el) el.textContent = text;
		};
		const fmtCount = (n) =>
			n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K` : String(n);
		set('hud-v-fps', String(v.fps));
		set('hud-v-ms', v.ms.toFixed(1));
		set('hud-v-calls', String(v.calls));
		set('hud-v-tris', fmtCount(v.tris));
		set('hud-v-mem', v.mem ? `${v.mem.toFixed(0)} MB` : 'N/A');
		set('hud-v-geo', String(v.geo));
		set('hud-v-tex', String(v.tex));
		this._redrawSparklines();
	}

	_redrawSparklines() {
		const hud = document.getElementById('hud');
		// Sparklines only render in expanded mode (they're hidden otherwise).
		if (!hud || !hud.classList.contains('hud--expanded')) return;
		const buffers = this._hudBuffers;
		if (!buffers) return;
		const W = 60;
		const H = 20;
		const keys = ['fps', 'ms', 'calls', 'tris', 'mem', 'geo', 'tex'];
		for (const k of keys) {
			const buf = buffers[k];
			let min = Infinity;
			let max = -Infinity;
			for (let i = 0; i < buf.length; i++) {
				const s = buf[i];
				if (s < min) min = s;
				if (s > max) max = s;
			}
			if (!isFinite(min) || !isFinite(max)) {
				min = 0;
				max = 1;
			}
			if (max - min < 1e-6) {
				// Flat series — pad the range so the line is centred & visible.
				const pad = Math.max(1, Math.abs(max) * 0.1);
				min -= pad;
				max += pad;
			}
			const range = max - min;
			const step = W / (buf.length - 1);
			let d = '';
			for (let i = 0; i < buf.length; i++) {
				const x = i * step;
				const y = H - ((buf[i] - min) / range) * H;
				d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' ';
			}
			const line = document.getElementById(`hud-p-${k}`);
			const fill = document.getElementById(`hud-f-${k}`);
			if (line) line.setAttribute('d', d.trim());
			if (fill) fill.setAttribute('d', (d + `L${W},${H} L0,${H} Z`).trim());
		}
	}

	updateGUI() {
		// Rebuild dynamic sections after a model loads/unloads.
		if (!this.schema) return;
		// Autoplay first clip, matching previous behavior.
		if (this.clips && this.clips.length) {
			this.state.actionStates = {};
			this.clips.forEach((clip, i) => {
				clip.name = `${i + 1}. ${clip.name}`;
				if (i === 0) {
					this.state.actionStates[clip.name] = true;
					this.mixer.clipAction(clip).play();
				} else {
					this.state.actionStates[clip.name] = false;
				}
			});
		}
		this.schema.animation.rows = this._buildAnimRows();
		this.schema.morph.rows = this._buildMorphRows();
		this.schema.cameras.rows = this._buildCameraRows();

		if (!this.schema[this.ui.activeTab].rows[this.ui.activeRow]) {
			this.ui.activeRow = 0;
		}
		this._renderRail();
		this._renderPane();
	}

	clear() {
		if (!this.content) return;

		this.scene.remove(this.content);

		// dispose geometry
		this.content.traverse((node) => {
			if (!node.geometry) return;

			node.geometry.dispose();
		});

		// dispose textures
		traverseMaterials(this.content, (material) => {
			for (const key in material) {
				if (key !== 'envMap' && material[key] && material[key].isTexture) {
					material[key].dispose();
				}
			}
		});
	}
}

function traverseMaterials(object, callback) {
	object.traverse((node) => {
		if (!node.geometry) return;
		const materials = Array.isArray(node.material) ? node.material : [node.material];
		materials.forEach(callback);
	});
}

// https://stackoverflow.com/a/9039885/1314762
function isIOS() {
	return (
		['iPad Simulator', 'iPhone Simulator', 'iPod Simulator', 'iPad', 'iPhone', 'iPod'].includes(
			navigator.platform,
		) ||
		// iPad on iOS 13 detection
		(navigator.userAgent.includes('Mac') && 'ontouchend' in document)
	);
}
