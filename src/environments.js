// Environment catalogue for the viewer.
//
// All Poly Haven entries point at 4K `.hdr` variants on `dl.polyhaven.org`
// (verified HTTP 200 + `access-control-allow-origin: *` from a GitHub Pages
// origin). 4K HDRs are ~15-30 MB each, so they are loaded LAZILY on select
// — see `getCubeMapTexture` in `viewer.js`, which also keeps an LRU cache
// of at most the 2 most-recently-used PMREM'd env maps and disposes older
// ones to release GPU memory.
//
// threejs.org examples CDN does not host 4K variants, so those entries keep
// their current 1k/2k size (these are fallbacks / classic references).
//
// Order is intentional: the most striking, GTA V-feel environments come
// first so they're the default-picked options in the dropdown.
export const environments = [
	{
		id: '',
		name: 'None',
		path: null,
	},
	{
		id: 'neutral', // THREE.RoomEnvironment
		name: 'Neutral',
		path: null,
	},
	// --- Premium cinematic / GTA V-aesthetic HDRIs (ordered by visual impact) ---
	{
		id: 'shanghai-bund',
		name: 'Shanghai Bund',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/shanghai_bund_4k.hdr',
		format: '.hdr',
	},
	{
		id: 'industrial-sunset',
		name: 'Industrial Sunset',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/industrial_sunset_puresky_4k.hdr',
		format: '.hdr',
	},
	{
		id: 'satara-night',
		name: 'Satara Night',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/satara_night_4k.hdr',
		format: '.hdr',
	},
	{
		id: 'neon-photostudio',
		name: 'Neon Studio',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/neon_photostudio_4k.hdr',
		format: '.hdr',
	},
	{
		id: 'sky-on-fire',
		name: 'Sky On Fire',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/the_sky_is_on_fire_4k.hdr',
		format: '.hdr',
	},
	{
		id: 'moonless-golf',
		name: 'Moonless Golf',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/moonless_golf_4k.hdr',
		format: '.hdr',
	},
	{
		id: 'urban-alley',
		name: 'Urban Alley',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/urban_alley_01_4k.hdr',
		format: '.hdr',
	},
	{
		id: 'potsdamer-platz',
		name: 'Potsdamer Platz',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/potsdamer_platz_4k.hdr',
		format: '.hdr',
	},
	{
		id: 'dikhololo-night',
		name: 'Dikhololo Night',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/dikhololo_night_4k.hdr',
		format: '.hdr',
	},
	{
		id: 'rogland-clear-night',
		name: 'Rogland Clear Night',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/rogland_clear_night_4k.hdr',
		format: '.hdr',
	},
	{
		id: 'circus-arena',
		name: 'Circus Arena',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/circus_arena_4k.hdr',
		format: '.hdr',
	},
	{
		id: 'mirrored-hall',
		name: 'Mirrored Hall',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/mirrored_hall_4k.hdr',
		format: '.hdr',
	},
	{
		id: 'kloofendal-clear-puresky',
		name: 'Kloofendal Clear',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/kloofendal_43d_clear_puresky_4k.hdr',
		format: '.hdr',
	},
	{
		id: 'venice-sunrise',
		name: 'Venice Sunrise',
		path: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/venice_sunrise_4k.hdr',
		format: '.hdr',
	},
	// --- threejs.org CDN (no 4k variants available; kept at source resolution) ---
	{
		id: 'venice-sunset',
		name: 'Venice Sunset',
		path: 'https://threejs.org/examples/textures/equirectangular/venice_sunset_1k.hdr',
		format: '.hdr',
	},
	{
		id: 'san-giuseppe',
		name: 'San Giuseppe Bridge',
		path: 'https://threejs.org/examples/textures/equirectangular/san_giuseppe_bridge_2k.hdr',
		format: '.hdr',
	},
	{
		id: 'quarry',
		name: 'Quarry',
		path: 'https://threejs.org/examples/textures/equirectangular/quarry_01_1k.hdr',
		format: '.hdr',
	},
	{
		id: 'spruit-sunrise',
		name: 'Spruit Sunrise',
		path: 'https://threejs.org/examples/textures/equirectangular/spruit_sunrise_1k.hdr.jpg',
		format: '.jpg',
	},
	{
		id: 'pedestrian-overpass',
		name: 'Pedestrian Overpass',
		path: 'https://threejs.org/examples/textures/equirectangular/pedestrian_overpass_1k.hdr',
		format: '.hdr',
	},
];
