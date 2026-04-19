import {
	AmbientLight,
	AnimationMixer,
	AxesHelper,
	Box3,
	Cache,
	Color,
	DirectionalLight,
	GridHelper,
	HemisphereLight,
	LoaderUtils,
	LoadingManager,
	PMREMGenerator,
	PerspectiveCamera,
	PointsMaterial,
	REVISION,
	Scene,
	SkeletonHelper,
	Vector3,
	WebGLRenderer,
	LinearToneMapping,
	ACESFilmicToneMapping,
} from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

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
			background: false,
			playbackSpeed: 1.0,
			actionStates: {},
			camera: DEFAULT_CAMERA,
			wireframe: false,
			skeleton: false,
			grid: false,
			autoRotate: false,

			// Lights
			punctualLights: true,
			exposure: 0.0,
			toneMapping: LinearToneMapping,
			ambientIntensity: 0.3,
			ambientColor: '#FFFFFF',
			directIntensity: 0.8 * Math.PI, // TODO(#116)
			directColor: '#FFFFFF',
			bgColor: '#191919',

			pointSize: 1.0,
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
		this.renderer.setClearColor(0xcccccc);
		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.setSize(el.clientWidth, el.clientHeight);

		this.pmremGenerator = new PMREMGenerator(this.renderer);
		this.pmremGenerator.compileEquirectangularShader();

		this.neutralEnvironment = this.pmremGenerator.fromScene(new RoomEnvironment()).texture;

		this.controls = new OrbitControls(this.defaultCamera, this.renderer.domElement);
		this.controls.screenSpacePanning = true;

		this.el.appendChild(this.renderer.domElement);

		this.skeletonHelpers = [];
		this.gridHelper = null;
		this.axesHelper = null;

		this.addAxesHelper();

		// Restore shareable state from ?s=<base64> BEFORE building the schema,
		// so initial renders reflect the incoming settings.
		this._applyStateFromUrl();

		this.addGUI();

		this.animate = this.animate.bind(this);
		requestAnimationFrame(this.animate);
		window.addEventListener('resize', this.resize.bind(this), false);
	}

	animate(time) {
		requestAnimationFrame(this.animate);

		const dt = (time - this.prevTime) / 1000;

		this.controls.update();
		this.stats.update();
		this.mixer && this.mixer.update(dt);
		this.render();
		this._updateRadarHUD();

		this.prevTime = time;
	}

	render() {
		this.renderer.render(this.scene, this.activeCamera);
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

		this.axesCamera.aspect = this.axesDiv.clientWidth / this.axesDiv.clientHeight;
		this.axesCamera.updateProjectionMatrix();
		this.axesRenderer.setSize(this.axesDiv.clientWidth, this.axesDiv.clientHeight);
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
		const size = box.getSize(new Vector3()).length();
		const center = box.getCenter(new Vector3());

		this.controls.reset();

		object.position.x -= center.x;
		object.position.y -= center.y;
		object.position.z -= center.z;

		this.controls.maxDistance = size * 10;

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

		this.content.traverse((node) => {
			if (node.isLight) {
				this.state.punctualLights = false;
			}
		});

		this.setClips(clips);

		this.updateLights();
		this.updateGUI();
		this.updateEnvironment();
		this.updateDisplay();

		window.VIEWER.scene = this.content;
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
		light2.position.set(0.5, 0, 0.866); // ~60º
		light2.name = 'main_light';
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

		this.getCubeMapTexture(environment).then(({ envMap }) => {
			this.scene.environment = envMap;
			this.scene.background = this.state.background ? envMap : this.backgroundColor;
		});
	}

	getCubeMapTexture(environment) {
		const { id, path } = environment;

		// neutral (THREE.RoomEnvironment)
		if (id === 'neutral') {
			return Promise.resolve({ envMap: this.neutralEnvironment });
		}

		// none
		if (id === '') {
			return Promise.resolve({ envMap: null });
		}

		return new Promise((resolve, reject) => {
			new EXRLoader().load(
				path,
				(texture) => {
					const envMap = this.pmremGenerator.fromEquirectangular(texture).texture;
					this.pmremGenerator.dispose();

					resolve({ envMap });
				},
				undefined,
				reject,
			);
		});
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

	updateBackground() {
		this.backgroundColor.set(this.state.bgColor);
	}

	/**
	 * Adds AxesHelper.
	 *
	 * See: https://stackoverflow.com/q/16226693/1314762
	 */
	addAxesHelper() {
		// GTA V-style radar minimap frame that wraps the 3D axes gizmo.
		this.radarFrame = document.createElement('div');
		this.radarFrame.classList.add('radar');
		this.radarFrame.setAttribute('aria-hidden', 'true');
		this.radarFrame.innerHTML = `
			<div class="radar__scanlines" aria-hidden="true"></div>
			<span class="radar__label">CAM</span>
			<div class="radar__compass" aria-hidden="true">
				<span class="radar__compass-n">N</span>
			</div>
			<span class="radar__zoom">×1.0</span>
		`;
		this.el.appendChild(this.radarFrame);

		this.axesDiv = document.createElement('div');
		this.radarFrame.appendChild(this.axesDiv);
		this.axesDiv.classList.add('axes');

		// Cache references for per-frame updates.
		this.radarCompass = this.radarFrame.querySelector('.radar__compass');
		this.radarZoom = this.radarFrame.querySelector('.radar__zoom');
		this._radarInitialDistance = null;

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

	_updateRadarHUD() {
		if (!this.radarFrame || !this.controls) return;
		// Compass: rotate N marker opposite to camera heading around target.
		if (this.radarCompass) {
			const offset = this.defaultCamera.position.clone().sub(this.controls.target);
			const heading = Math.atan2(offset.x, offset.z); // radians
			const deg = -(heading * 180) / Math.PI;
			this.radarCompass.style.transform = `rotate(${deg.toFixed(1)}deg)`;
		}
		// Zoom: ratio of initial-to-current OrbitControls distance.
		if (this.radarZoom) {
			const dist = this.defaultCamera.position.distanceTo(this.controls.target);
			if (
				this._radarInitialDistance == null ||
				!isFinite(this._radarInitialDistance) ||
				this._radarInitialDistance === 0
			) {
				this._radarInitialDistance = dist || 1;
			}
			const ratio = this._radarInitialDistance / (dist || 1);
			this.radarZoom.textContent = `×${ratio.toFixed(1)}`;
		}
	}

	addGUI() {
		this.ui = {
			activeTab: 'map',
			activeRow: 0,
			tabsEl: document.getElementById('pm-tabs'),
			railEl: document.getElementById('pm-rail'),
			paneEl: document.getElementById('pm-pane'),
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
						key: 'overview',
						label: 'Overview',
						type: 'map',
						view: 'overview',
						desc: 'Top-down schematic of the loaded model. Your viewpoint is the red marker.',
					},
					{
						key: 'dimensions',
						label: 'Dimensions',
						type: 'map',
						view: 'dimensions',
						desc: 'Bounding-box extents along each world axis, in scene units.',
					},
					{
						key: 'axes',
						label: 'Axes',
						type: 'map',
						view: 'axes',
						desc: 'Cardinal orientation and the world-axis legend.',
					},
					{
						key: 'center',
						label: 'Center',
						type: 'map',
						view: 'center',
						desc: 'World-space center of the bounding box.',
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
						key: 'export',
						label: 'Export',
						type: 'brief',
						view: 'export',
						desc: 'Scene load status and asset readiness indicators.',
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
						desc: 'Render the environment as the scene background instead of a solid color.',
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
						get: () => state.autoRotate,
						set: (v) => {
							state.autoRotate = v;
							this.updateDisplay();
						},
					},
					{
						key: 'wireframe',
						label: 'Wireframe',
						type: 'bool',
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
						get: () => state.grid,
						set: (v) => {
							state.grid = v;
							this.updateDisplay();
						},
					},
					{
						key: 'screenSpacePanning',
						label: 'Screen-Space Pan',
						type: 'bool',
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
						get: () => (state.toneMapping === ACESFilmicToneMapping ? 'ACES Filmic' : 'Linear'),
						set: (v) => {
							state.toneMapping = v === 'ACES Filmic' ? ACESFilmicToneMapping : LinearToneMapping;
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
						get: () => state.directColor,
						set: (v) => {
							state.directColor = v;
							this.updateLights();
						},
					},
				],
			},
			animation: { label: 'ANIMATION', rows: this._buildAnimRows() },
			morph: { label: 'MORPH', rows: this._buildMorphRows() },
			cameras: { label: 'CAMERAS', rows: this._buildCameraRows() },
			performance: {
				label: 'PERFORMANCE',
				rows: [
					{
						key: 'stats',
						label: 'Performance Monitor',
						type: 'stats',
						desc: 'Frames-per-second, memory, and per-frame milliseconds. Click the panel to cycle metrics.',
					},
				],
			},
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
			run: () => this.playAllClips(),
		});
		rows.push({
			key: 'playbackSpeed',
			label: 'Playback Speed',
			type: 'num',
			min: 0,
			max: 1,
			step: 0.01,
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
				keys: ['background', 'autoRotate', 'wireframe', 'skeleton', 'grid', 'pointSize', 'bgColor'],
				apply: () => {
					this.backgroundColor.set(this.state.bgColor);
					if (this.updateBackground) this.updateBackground();
					this.updateEnvironment();
					this.updateDisplay();
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

		// Toggle scroll fade indicators when there are more than 10 rows.
		railEl.classList.toggle('pm__rail--scrollable', rows.length > 10);

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
		title.textContent = `${section.label} // ${rows.length}`;
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
			btn.querySelector('.pm__row-value').textContent = this._formatValue(row);
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
		if (row.type === 'stats') return '';
		if (row.type === 'map') return '◉';
		if (row.type === 'brief') return '◆';
		const v = row.get ? row.get() : '';
		if (row.type === 'bool') return v ? 'ON' : 'OFF';
		if (row.type === 'num')
			return typeof v === 'number' ? v.toFixed(2).replace(/\.00$/, '') : v;
		if (row.type === 'color') return String(v).toUpperCase();
		if (row.type === 'enum') return String(v).toUpperCase();
		return v;
	}

	_selectRow(i) {
		this.ui.activeRow = i;
		const rows = this.ui.railEl.querySelectorAll('.pm__row');
		rows.forEach((el, idx) => el.setAttribute('aria-selected', idx === i ? 'true' : 'false'));
		this._renderPane();
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
				<div class="pm__empty-state" role="status" aria-label="${sectionLabel} unavailable">
					<svg class="pm__empty-state__icon" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
						<rect x="14" y="28" width="36" height="26" fill="none" stroke="currentColor" stroke-width="2"/>
						<path d="M22 28 V18 a10 10 0 0 1 20 0 V28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/>
						<circle cx="32" cy="40" r="3" fill="currentColor"/>
						<line x1="32" y1="42" x2="32" y2="48" stroke="currentColor" stroke-width="2"/>
					</svg>
					<span class="pm__empty-state__stamp">OFFLINE</span>
					<p class="pm__empty-state__hint">Load a model to unlock ${sectionLabel.toLowerCase()} controls.</p>
				</div>
			`;
			inner.querySelector('.pm__pane-title').textContent = sectionLabel;
			inner.querySelector('.pm__pane-sub').textContent = `${sectionLabel} // LOCKED`;
			paneEl.innerHTML = '';
			paneEl.appendChild(inner);
			return;
		}

		const isMap = row.type === 'map';
		const isBrief = row.type === 'brief';
		let title;
		if (isMap) title = 'MODEL SCHEMATIC';
		else if (isBrief) title = 'ASSET BRIEFING';
		else title = String(row.label).toUpperCase();
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
		let sub;
		if (isMap) sub = `MAP // ${String(row.label).toUpperCase()}`;
		else if (isBrief) sub = `BRIEF // ${String(row.label).toUpperCase()}`;
		else sub = `${section.label} // ${row.type.toUpperCase()}`;
		inner.querySelector('.pm__pane-sub').textContent = sub;

		paneEl.innerHTML = '';
		paneEl.appendChild(inner);
		this._renderEditor(row);
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
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'pm__action-btn';
			b.textContent = rowLabel;
			b.setAttribute('aria-label', `Run ${rowLabel}`);
			b.addEventListener('click', () => row.run && row.run());
			editorEl.appendChild(b);
		} else if (row.type === 'map') {
			this._renderMapPane(editorEl, row);
		} else if (row.type === 'brief') {
			this._renderBriefPane(editorEl, row);
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

	_renderMapPane(editorEl, row) {
		const view = row.view || 'overview';

		// Compute bounding box from the loaded content (if any).
		let box = null;
		const size = new Vector3();
		const center = new Vector3();
		if (this.content) {
			box = new Box3().setFromObject(this.content);
			box.getSize(size);
			box.getCenter(center);
		}

		const hasModel = !!box;

		// SVG viewBox: 400x400; model footprint maps into a padded 320x320 area.
		const VB = 400;
		const PAD = 40;
		const INNER = VB - PAD * 2;

		const svgNS = 'http://www.w3.org/2000/svg';

		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('class', 'pm__map-svg');
		svg.setAttribute('viewBox', `0 0 ${VB} ${VB}`);
		svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', 'Top-down minimap of the loaded model');

		// Frame.
		const frame = document.createElementNS(svgNS, 'rect');
		frame.setAttribute('x', PAD);
		frame.setAttribute('y', PAD);
		frame.setAttribute('width', INNER);
		frame.setAttribute('height', INNER);
		frame.setAttribute('class', 'pm__map-frame');
		svg.appendChild(frame);

		// Grid (faint ticks).
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

		// Center axes (stronger stroke).
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

		// Cardinal labels.
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

		// Axis legend (bottom-left corner, inside frame).
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

		// Projection helpers: X -> SVG x, Z -> SVG y (+Z goes south/down).
		const rangeX = hasModel ? Math.max(size.x, 1e-6) : 1;
		const rangeZ = hasModel ? Math.max(size.z, 1e-6) : 1;
		const worldRange = Math.max(rangeX, rangeZ) * 1.4; // 40% pad for markers
		const cx = hasModel ? center.x : 0;
		const cz = hasModel ? center.z : 0;

		const worldToSvgX = (wx) => VB / 2 + ((wx - cx) / worldRange) * INNER;
		const worldToSvgY = (wz) => VB / 2 + ((wz - cz) / worldRange) * INNER;
		const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

		// Model footprint rectangle.
		if (hasModel) {
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

			const centerDot = document.createElementNS(svgNS, 'circle');
			centerDot.setAttribute('cx', worldToSvgX(cx));
			centerDot.setAttribute('cy', worldToSvgY(cz));
			centerDot.setAttribute('r', 3);
			centerDot.setAttribute('class', 'pm__map-center');
			svg.appendChild(centerDot);
		}

		// "You are here" camera marker (live-updated).
		const camMarker = document.createElementNS(svgNS, 'g');
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

		const wrap = document.createElement('div');
		wrap.className = 'pm__map';
		wrap.dataset.view = view;
		wrap.appendChild(svg);

		const fmt = (n) =>
			typeof n === 'number' && Number.isFinite(n)
				? Math.abs(n) >= 100
					? n.toFixed(1)
					: n.toFixed(3)
				: '—';

		const stats = hasModel
			? [
					['Width', fmt(size.x), 'x'],
					['Height', fmt(size.y), 'y'],
					['Depth', fmt(size.z), 'z'],
					['Center X', fmt(center.x), 'x'],
					['Center Y', fmt(center.y), 'y'],
					['Center Z', fmt(center.z), 'z'],
				]
			: [
					['Width', '—', 'x'],
					['Height', '—', 'y'],
					['Depth', '—', 'z'],
					['Center X', '—', 'x'],
					['Center Y', '—', 'y'],
					['Center Z', '—', 'z'],
				];

		const statsGrid = document.createElement('div');
		statsGrid.className = 'pm__map-stats';
		stats.forEach(([label, value, axis]) => {
			const cell = document.createElement('div');
			cell.className = 'pm__map-stat';
			cell.dataset.axis = axis;
			cell.innerHTML =
				'<span class="pm__map-stat-label"></span>' +
				'<span class="pm__map-stat-value"></span>';
			cell.querySelector('.pm__map-stat-label').textContent = label.toUpperCase();
			cell.querySelector('.pm__map-stat-value').textContent = value;
			statsGrid.appendChild(cell);
		});
		wrap.appendChild(statsGrid);

		if (!hasModel) {
			const empty = document.createElement('p');
			empty.className = 'pm__empty pm__map-empty';
			empty.textContent = 'NO MODEL LOADED';
			wrap.appendChild(empty);
		}

		editorEl.appendChild(wrap);

		// Live-update loop: reproject the camera onto XZ each frame.
		const tmp = new Vector3();
		const tmpDir = new Vector3();
		const tick = () => {
			if (!svg.isConnected) {
				this._mapTickerId = null;
				return;
			}
			const cam = this.activeCamera || this.defaultCamera;
			cam.getWorldPosition(tmp);
			const px = clamp(worldToSvgX(tmp.x), PAD, PAD + INNER);
			const py = clamp(worldToSvgY(tmp.z), PAD, PAD + INNER);
			cam.getWorldDirection(tmpDir);
			// Heading on XZ; 0deg = north (up in SVG).
			const headingDeg = (Math.atan2(tmpDir.x, -tmpDir.z) * 180) / Math.PI;
			camMarker.setAttribute('transform', `translate(${px}, ${py}) rotate(${headingDeg})`);
			this._mapTickerId = requestAnimationFrame(tick);
		};
		this._mapTickerId = requestAnimationFrame(tick);
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
				if (node.geometry && node.geometry.attributes && node.geometry.attributes.position) {
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

		const header = document.createElement('div');
		header.className = 'pm__brief-header';
		header.innerHTML = `
			<div class="pm__brief-header-top">
				<span class="pm__brief-eyebrow">CLASSIFIED // MISSION PACKET</span>
				<span class="pm__brief-eyebrow"></span>
			</div>
			<h3 class="pm__brief-headline">ASSET BRIEFING</h3>
			<div class="pm__brief-divider"></div>
		`;
		header.querySelectorAll('.pm__brief-eyebrow')[1].textContent = `SECTION ${String(
			view,
		).toUpperCase()}`;
		shell.appendChild(header);

		if (noModel) {
			const empty = document.createElement('div');
			empty.className = 'pm__brief-empty';
			empty.innerHTML = `
				<span class="pm__brief-stamp">AWAITING TARGET</span>
				<p class="pm__empty">Load a glTF asset to populate the briefing packet.</p>
			`;
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
		nodesSec.querySelector('.pm__brief-section-count').textContent = `${data.nodes.length} / ${data.nodeTotal}`;
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
		matsSec.querySelector('.pm__brief-section-count').textContent = String(data.materials.length);
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

		const prog = document.createElement('section');
		prog.className = 'pm__brief-section';
		prog.setAttribute('data-section', 'export');
		prog.setAttribute('data-active', view === 'export' ? 'true' : 'false');
		prog.innerHTML = `
			<div class="pm__brief-section-head">
				<span class="pm__brief-section-title">SCENE LOAD</span>
				<span class="pm__brief-section-count">100%</span>
			</div>
			<div class="pm__brief-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100">
				<div class="pm__brief-progress-fill"></div>
			</div>
			<p class="pm__brief-signoff"></p>
		`;
		prog.querySelector('.pm__brief-signoff').textContent = `READY FOR DEPLOYMENT // ${new Date()
			.toISOString()
			.split('T')[0]}`;
		shell.appendChild(prog);

		editorEl.appendChild(shell);
	}

	_refreshRowValueOnly() {
		const row = this.schema[this.ui.activeTab].rows[this.ui.activeRow];
		const sel = `[data-row="${this.ui.activeRow}"] .pm__row-value`;
		const el = this.ui.railEl.querySelector(sel);
		if (!el || !row) return;
		el.textContent = this._formatValue(row);
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
		const share = document.getElementById('pm-share');
		if (share && !share._wired) {
			share._wired = true;
			share.addEventListener('click', () => this._copyShareLink(share));
		}
		if (!this._keyHandler) {
			this._keyHandler = (e) => this._onKey(e);
			window.addEventListener('keydown', this._keyHandler);
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
	}

	_onKey(e) {
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
			if (row.type === 'action') {
				e.preventDefault();
				row.run && row.run();
			} else if (row.type === 'bool') {
				e.preventDefault();
				row.set(!row.get());
				this._renderRail();
				this._renderPane();
			}
		}
	}

	_startMetaLoop() {
		if (this._metaLoopStarted) return;
		this._metaLoopStarted = true;
		const fpsEl = document.getElementById('pm-fps');
		const trisEl = document.getElementById('pm-tris');
		const callsEl = document.getElementById('pm-calls');
		let last = performance.now();
		let frames = 0;
		const tick = (t) => {
			frames++;
			if (t - last >= 500) {
				const fps = Math.round((frames * 1000) / (t - last));
				if (fpsEl) fpsEl.textContent = fps;
				frames = 0;
				last = t;
			}
			if (this.renderer && this.renderer.info) {
				const tri = this.renderer.info.render.triangles;
				const calls = this.renderer.info.render.calls;
				if (trisEl) trisEl.textContent = tri.toLocaleString();
				if (callsEl) callsEl.textContent = calls;
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
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

		// Auto-open menu on first model load.
		if (!this.ui.menuAutoOpened && !this.options.kiosk) {
			this.ui.menuAutoOpened = true;
			this._setMenuOpen(true);
		}
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
