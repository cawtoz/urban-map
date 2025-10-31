// Capas base (usamos Positron como predeterminada porque es limpia y permite que los marcadores destaquen)
const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
});

const pos = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/attributions">CartoDB</a>',
    maxZoom: 19
});

const esriSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19
});

// Topo removed per user request

// Inicializar el mapa con Positron por defecto. No cerrar popup al hacer click.
// Centro fijo en Capuchina (ajustado mucho más a la derecha)
const map = L.map('map', {
    closePopupOnClick: false,
    layers: [pos]
}).setView([4.604169891807999, -74.07385381204059], 15);

// Control para cambiar entre basemaps (guardamos referencia para añadir overlays dinámicos)
const baseLayers = {
    'Callejero': osm,
    'Claro': pos,
    'Satélite': esriSat
};
const overlays = {}; // iremos añadiendo overlays como 'Zonas verdes'
// Place layer control at top-left but shift it right to avoid overlapping the Leaflet zoom buttons
const layerControl = L.control.layers(baseLayers, overlays, { position: 'topleft' }).addTo(map);
try {
const lcContainer = layerControl.getContainer();
if (lcContainer && lcContainer.style) {
    // Move it slightly to the right so it doesn't cover the zoom control
    lcContainer.style.left = '45px';
    lcContainer.style.top = '-73px';
}
} catch (err) { console.warn('No se pudo reposicionar control de capas:', err); }

// Capa vacía para las zonas verdes (será poblada desde Overpass)
const greenStyle = {
    color: '#2f855a',
    weight: 1,
    fillColor: 'rgba(34,197,94,0.35)',
    fillOpacity: 0.5
};

const greenLayer = L.geoJSON(null, {
    style: greenStyle,
    onEachFeature: function(feature, layer) {
        // opcional: mostrar nombre si existe
        if (feature.properties && (feature.properties.name || feature.properties['name:es'])) {
            const name = feature.properties.name || feature.properties['name:es'];
            layer.bindPopup(`<strong>${name}</strong>`);
        }
    }
});

let greenLayerLoaded = false;
// Coordenadas de las delimitaciones en formato [lng, lat]
// Ahora soportamos múltiples polígonos (capuchina.json y veracruz.json)
let delimPolygonsCoordsLonLat = [];

// Variables para la máscara circular
let outsideCircleMask = null;
let outsideCircleOutline = null;

// Controla visibilidad de greenLayer según basemap activo
function updateGreenLayerVisibility() {
    // Sólo mostrar si ya cargamos los datos y el basemap actual es 'Claro' (pos)
    try {
        if (!greenLayerLoaded) return;
        if (map.hasLayer(pos)) {
            if (!map.hasLayer(greenLayer)) map.addLayer(greenLayer);
        } else {
            if (map.hasLayer(greenLayer)) map.removeLayer(greenLayer);
        }
    } catch (err) {
        console.warn('Error actualizando visibilidad de greenLayer', err);
    }
}

// Escuchar cambios de basemap para alternar la capa verde
map.on('baselayerchange', function(e) {
    // e.name suele ser el nombre del layer registrado ('Claro' para pos)
    updateGreenLayerVisibility();
});

// Punto en polígono - ray-casting (entrada: point [lon, lat], vs: array de [lon, lat])
function pointInPolygon(point, vs) {
    const x = point[0], y = point[1];
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        const xi = vs[i][0], yi = vs[i][1];
        const xj = vs[j][0], yj = vs[j][1];

        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 0.0) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Decide si una feature (Point/LineString/Polygon/MultiPolygon) tiene parte dentro de la delimitación
function featureIntersectsDelim(feature, delimCoords) {
    if (!feature || !feature.geometry) return false;
    const geom = feature.geometry;
    // Helper para probar arrays de coordenadas (p. ej. rings)
    function anyCoordInside(coords) {
        for (let i = 0; i < coords.length; i++) {
            const c = coords[i];
            // coord could be [lon, lat] or nested
            if (Array.isArray(c[0])) {
                if (anyCoordInside(c)) return true;
            } else {
                if (pointInPolygon(c, delimCoords)) return true;
            }
        }
        return false;
    }

    if (geom.type === 'Point') {
        return pointInPolygon(geom.coordinates, delimCoords);
    }
    if (geom.type === 'LineString' || geom.type === 'MultiPoint') {
        return anyCoordInside(geom.coordinates);
    }
    if (geom.type === 'Polygon' || geom.type === 'MultiLineString') {
        return anyCoordInside(geom.coordinates);
    }
    if (geom.type === 'MultiPolygon') {
        return anyCoordInside(geom.coordinates);
    }
    return false;
}

// Convierte la respuesta de Overpass (out geom) a GeoJSON simple
function overpassToGeoJSON(data) {
    const features = [];
    if (!data || !data.elements) return { type: 'FeatureCollection', features };
    data.elements.forEach(el => {
        try {
            if (el.type === 'node') {
                features.push({
                    type: 'Feature',
                    properties: el.tags || {},
                    geometry: { type: 'Point', coordinates: [el.lon, el.lat] }
                });
            } else if ((el.type === 'way' || el.type === 'relation') && el.geometry) {
                const coords = el.geometry.map(p => [p.lon, p.lat]);
                if (coords.length >= 3) {
                    // Asegurar anillo cerrado
                    const first = coords[0];
                    const last = coords[coords.length - 1];
                    if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
                    features.push({
                        type: 'Feature',
                        properties: el.tags || {},
                        geometry: { type: 'Polygon', coordinates: [coords] }
                    });
                } else {
                    features.push({
                        type: 'Feature',
                        properties: el.tags || {},
                        geometry: { type: 'LineString', coordinates: coords }
                    });
                }
            }
        } catch (err) {
            console.warn('Error convirtiendo elemento Overpass a GeoJSON', err, el);
        }
    });
    return { type: 'FeatureCollection', features };
}

// Cargar áreas verdes usando Overpass (bbox: {south,west,north,east})
function loadGreenAreas(bbox) {
    if (greenLayerLoaded) return;
    console.log('Cargando zonas verdes, bbox=', bbox);

    const s = bbox.south, w = bbox.west, n = bbox.north, e = bbox.east;
    const query = `
[out:json][timeout:25];
(
way["leisure"="park"](${s},${w},${n},${e});
relation["leisure"="park"](${s},${w},${n},${e});
way["natural"="wood"](${s},${w},${n},${e});
relation["natural"="wood"](${s},${w},${n},${e});
way["landuse"="grass"](${s},${w},${n},${e});
relation["landuse"="grass"](${s},${w},${n},${e});
way["landuse"="recreation_ground"](${s},${w},${n},${e});
relation["landuse"="recreation_ground"](${s},${w},${n},${e});
);
out body geom;
`;

    fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: query,
        headers: { 'Content-Type': 'text/plain' }
    })
    .then(r => r.json())
    .then(data => {
        const geojson = overpassToGeoJSON(data);
        // Si tenemos delimitaciones, filtrar features para que sólo queden las que intersectan
        let features = geojson.features || [];
        if (delimPolygonsCoordsLonLat && delimPolygonsCoordsLonLat.length) {
            features = features.filter(f => featureIntersectsAnyDelim(f, delimPolygonsCoordsLonLat));
        }
        const filtered = { type: 'FeatureCollection', features };
        greenLayer.addData(filtered);
        // No añadir automáticamente a map: controlaremos visibilidad según basemap
        greenLayerLoaded = true;
        updateGreenLayerVisibility();
        console.log('Zonas verdes cargadas (dentro de delimitación):', filtered.features.length, 'features');
    })
    .catch(err => {
        console.error('Error cargando zonas verdes desde Overpass:', err);
    });
}

// Helper: comprobar si una feature intersecta alguna de las delimitaciones
function featureIntersectsAnyDelim(feature, polygons) {
    if (!polygons || !polygons.length) return false;
    for (let i = 0; i < polygons.length; i++) {
        try {
            if (featureIntersectsDelim(feature, polygons[i])) return true;
        } catch (e) { /* continue */ }
    }
    return false;
}

// Cargar las delimitaciones desde capichian.json y veracruz.json
Promise.all([
    fetch('capuchina.json').then(r => r.json()).catch(() => null),
    fetch('veracruz.json').then(r => r.json()).catch(() => null)
])
.then(datasets => {
    try {
        const drawCoordsForBbox = [];
        const styles = [
            { stroke: '#1e78c8', fill: 'rgba(30,120,200,0.08)' }, // suave azul
            { stroke: '#8b5a2b', fill: 'rgba(139,90,43,0.06)' }   // suave barro/marrón
        ];

        datasets.forEach((data, idx) => {
            if (!data || !data.features) return;
            data.features.forEach((feat) => {
                if (!feat.geometry) return;
                // Soportar Polygon y MultiPolygon (usar el primer anillo)
                let coords = [];
                if (feat.geometry.type === 'Polygon') {
                    coords = feat.geometry.coordinates[0];
                } else if (feat.geometry.type === 'MultiPolygon') {
                    coords = feat.geometry.coordinates[0][0];
                } else {
                    return;
                }

                // Guardar en formato [lng, lat] para uso en pointInPolygon
                delimPolygonsCoordsLonLat.push(coords.slice());

                // Convertir a [lat, lng] para Leaflet
                const polygonCoords = coords.map(c => [c[1], c[0]]);

                // Dibujar polígono con estilo sutil
                const s = styles[idx % styles.length];
                L.polygon(polygonCoords, {
                    color: s.stroke,
                    weight: 1.5,
                    fillColor: s.fill,
                    fillOpacity: 1,
                    interactive: false
                }).addTo(map);

                // Añadir las coordenadas al array para cálculo de bbox
                polygonCoords.forEach(pc => drawCoordsForBbox.push(pc));
            });
        });

        // Si tenemos coordenadas, calcular bbox y cargar zonas verdes
        if (drawCoordsForBbox.length) {
            const lats = drawCoordsForBbox.map(c => c[0]);
            const lngs = drawCoordsForBbox.map(c => c[1]);
            const bbox = {
                south: Math.min.apply(null, lats),
                north: Math.max.apply(null, lats),
                west: Math.min.apply(null, lngs),
                east: Math.max.apply(null, lngs)
            };
            loadGreenAreas(bbox);
        }
    } catch (err) {
        console.error('Error procesando delimitaciones:', err);
    }
})
.catch(err => {
    console.error('Error cargando archivos de delimitación:', err);
});

// Referencias al contenedor de audio y botón flotante
const audioContainer = document.getElementById('audio-container');
const mixerTracks = document.getElementById('mixer-tracks');
const openMixerBtn = document.getElementById('open-mixer-btn');

// Mostrar el mezclador al hacer click en el botón flotante
if (openMixerBtn) {
    openMixerBtn.addEventListener('click', function() {
        audioContainer.classList.add('active');
        audioContainer.classList.remove('minimized');
        openMixerBtn.style.display = 'none';
    });
}



// Minimizar/restaurar el mezclador
audioContainer.addEventListener('click', function(e) {
    if (e.target.classList.contains('mixer-minimize') || (e.target.closest && e.target.closest('.mixer-minimize'))) {
        if (audioContainer.classList.contains('minimized')) {
            audioContainer.classList.remove('minimized');
        } else {
            audioContainer.classList.add('minimized');
        }
    }
});

// Restaurar el mezclador al hacer clic en la cabecera cuando está minimizado
const mixerHeader = audioContainer.querySelector('.mixer-header');
if (mixerHeader) {
    mixerHeader.addEventListener('click', function(e) {
        // Solo restaurar si está minimizado y no se hizo clic en el botón de cerrar
        if (audioContainer.classList.contains('minimized') && !e.target.classList.contains('mixer-close')) {
            audioContainer.classList.remove('minimized');
        }
    });
}

// Cuando se cierra el mezclador, mostrar el botón flotante
const mixerCloseBtn = document.querySelector('.mixer-close');
if (mixerCloseBtn) {
    mixerCloseBtn.addEventListener('click', function() {
        audioContainer.classList.remove('active');
        audioContainer.classList.remove('minimized');
        openMixerBtn.style.display = 'flex';
    });
}

// Si el mezclador se minimiza, mostrar el botón flotante al restaurar
audioContainer.addEventListener('transitionend', function() {
    if (!audioContainer.classList.contains('active')) {
        openMixerBtn.style.display = 'flex';
    }
});

// Variables para rastrear el video activo y audios activos
let currentVideoPopup = null; // (legacy name, kept for compatibility)
let currentVideoMarker = null; // marcador cuyo video está abierto en el panel
let activeAudios = new Map(); // Guarda los audios activos por ID de ubicación

// Elementos del panel de video
const videoPanel = document.getElementById('video-panel');
const sideVideo = document.getElementById('side-video');
// target the inner title text span so updates don't clobber the mini-icon element
const videoTitleEl = videoPanel ? videoPanel.querySelector('.video-title .title-text') : null;

function openVideoPanel(location, marker) {
    try {
        // Restaurar estilo del video anterior si existe
        if (currentVideoMarker && currentVideoMarker !== marker) {
            try { updateMarkerStyle(currentVideoMarker, false); } catch (e) {}
        }

        // Marcar el actual como activo (badge gris)
        currentVideoMarker = marker;
        try { updateMarkerStyle(marker, true); } catch (e) {}

        // Configurar fuente y título
        if (sideVideo) {
            sideVideo.pause();
            sideVideo.src = location.file;
            sideVideo.currentTime = 0;
            sideVideo.play().catch(() => {});
        }
        if (videoTitleEl) videoTitleEl.textContent = location.title || 'Video';

        if (videoPanel) {
            videoPanel.style.display = '';
            videoPanel.classList.remove('minimized');
            // ensure the panel fits the viewport (responsive adjustment)
            try { ensureVideoPanelFits(); } catch (e) {}
            // restore minimize button icon to 'minimize'
            try {
                const vMinBtn = document.getElementById('video-minimize');
                if (vMinBtn) vMinBtn.innerHTML = '<i class="fas fa-window-minimize"></i>';
            } catch (e) {}
        }
    } catch (err) {
        console.warn('No se pudo abrir el panel de video', err);
    }
}

function closeVideoPanel() {
    try {
        if (sideVideo) {
            sideVideo.pause();
            sideVideo.src = '';
        }
        if (currentVideoMarker) {
            try { updateMarkerStyle(currentVideoMarker, false); } catch (e) {}
            currentVideoMarker = null;
        }
        if (videoPanel) videoPanel.style.display = 'none';
    } catch (err) { console.warn(err); }
}

function toggleMinimizeVideo() {
    if (!videoPanel) return;
    const isNowMin = videoPanel.classList.toggle('minimized');
    // If minimized, force the inline size to the compact dimensions so CSS isn't
    // overridden by previously set inline width/height from ensureVideoPanelFits.
    try {
        const vMinBtn = document.getElementById('video-minimize');
        if (isNowMin) {
            videoPanel.style.width = 'auto';
            videoPanel.style.height = '44px';
            // pause video to avoid continued playback while minimized
            if (sideVideo && !sideVideo.paused) sideVideo.pause();
            // change minimize icon to 'restore' affordance
            if (vMinBtn) vMinBtn.innerHTML = '<i class="fas fa-window-restore"></i>';
        } else {
            // Remove explicit inline sizing and recompute responsive size
            videoPanel.style.width = '';
            videoPanel.style.height = '';
            ensureVideoPanelFits();
            // restore icon to minimize
            if (vMinBtn) vMinBtn.innerHTML = '<i class="fas fa-window-minimize"></i>';
        }
    } catch (e) { /* no-op */ }
}

// Conectar botones del panel
try {
    const vClose = document.getElementById('video-close');
    const vMin = document.getElementById('video-minimize');
    if (vClose) vClose.addEventListener('click', closeVideoPanel);
    if (vMin) vMin.addEventListener('click', toggleMinimizeVideo);
} catch (err) { }

// Make the header clickable when minimized to restore the panel
try {
    const headerEl = videoPanel ? videoPanel.querySelector('.video-header') : null;
    if (headerEl) {
        headerEl.addEventListener('click', function(e) {
            // Ignore clicks that originate inside the action buttons (to avoid double-toggle)
            if (e.target && e.target.closest && e.target.closest('.video-actions')) return;
            // only toggle (restore) if currently minimized
            if (videoPanel && videoPanel.classList.contains('minimized')) {
                toggleMinimizeVideo();
            }
        });
    }
    // Prevent the minimize/close buttons from letting the header handler double-toggle
    const vMinBtn = document.getElementById('video-minimize');
    if (vMinBtn) vMinBtn.addEventListener('click', function(ev) { ev.stopPropagation(); });
    const vCloseBtn = document.getElementById('video-close');
    if (vCloseBtn) vCloseBtn.addEventListener('click', function(ev) { ev.stopPropagation(); });
} catch (err) { /* ignore */ }

// Ensure the video panel fits the viewport and doesn't overflow
function ensureVideoPanelFits() {
    if (!videoPanel) return;
    // If hidden or minimized, nothing to adjust
    if (videoPanel.style.display === 'none' || videoPanel.classList.contains('minimized')) return;
    // Responsive width/height limits
    const maxW = Math.floor(window.innerWidth * 0.92);
    const preferW = Math.min(360, Math.floor(window.innerWidth * 0.45));
    const newW = Math.min(preferW, maxW);

    const maxH = Math.floor(window.innerHeight * 0.8);
    const preferH = Math.min(260, Math.floor(window.innerHeight * 0.5));
    const newH = Math.min(preferH, maxH);

    videoPanel.style.width = newW + 'px';
    videoPanel.style.height = newH + 'px';

    // Keep it slightly inset from edges
    videoPanel.style.right = '12px';
    videoPanel.style.bottom = '12px';
}

// Adjust when resizing window so the panel never overflows
window.addEventListener('resize', function() {
    try { ensureVideoPanelFits(); } catch (e) {}
});

// Función para cerrar todos los audios
function closeAllAudios() {
    // Restaurar el color de todos los marcadores antes de pausar
    activeAudios.forEach((audioData, locationId) => {
        audioData.audio.pause();
        // Restaurar color del marcador a inactivo
        if (audioData.marker) {
            updateMarkerStyle(audioData.marker, false);
        }
    });
    activeAudios.clear();
    mixerTracks.innerHTML = '';
    audioContainer.classList.remove('active');
}

// Función para crear una pista de audio en el mezclador
function createAudioTrack(location) {
    // Si ya existe una pista para esta ubicación, no crear otra
    if (activeAudios.has(location.id)) {
        return;
    }
    
    // Crear el elemento de la pista
    const trackDiv = document.createElement('div');
    trackDiv.className = 'audio-track';
    trackDiv.dataset.locationId = location.id;
    
    // Crear elemento de audio (oculto)
    const audio = document.createElement('audio');
    audio.src = location.file;
    audio.volume = 0.7;
    
    // Header de la pista
    const trackHeader = document.createElement('div');
    trackHeader.className = 'track-header';
    
    const trackName = document.createElement('div');
    trackName.className = 'track-name';
    trackName.innerHTML = `<i class="fas fa-music"></i> ${location.title}`;
    
    const removeBtn = document.createElement('button');
    removeBtn.className = 'track-remove';
    removeBtn.innerHTML = '<i class="fas fa-times"></i>';
    removeBtn.onclick = function() {
        removeAudioTrack(location.id);
    };
    
    trackHeader.appendChild(trackName);
    trackHeader.appendChild(removeBtn);
    
    // Controles de la pista
    const trackControls = document.createElement('div');
    trackControls.className = 'track-controls';
    
    // Botón de play/pause
    const playPauseBtn = document.createElement('button');
    playPauseBtn.className = 'play-pause-btn';
    playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
    playPauseBtn.onclick = function() {
        if (audio.paused) {
            audio.play();
            playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
        } else {
            audio.pause();
            playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
        }
    };
    
    // Control de volumen
    const volumeControl = document.createElement('div');
    volumeControl.className = 'volume-control';
    
    const volumeIcon = document.createElement('i');
    volumeIcon.className = 'volume-icon fas fa-volume-up';
    
    const volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.className = 'volume-slider';
    volumeSlider.min = '0';
    volumeSlider.max = '100';
    volumeSlider.value = '70';
    volumeSlider.oninput = function() {
        audio.volume = this.value / 100;
        volumeValue.textContent = this.value + '%';
        updateVolumeIcon(volumeIcon, this.value);
    };
    
    const volumeValue = document.createElement('span');
    volumeValue.className = 'volume-value';
    volumeValue.textContent = '70%';
    
    volumeControl.appendChild(volumeIcon);
    volumeControl.appendChild(volumeSlider);
    volumeControl.appendChild(volumeValue);
    
    trackControls.appendChild(playPauseBtn);
    trackControls.appendChild(volumeControl);
    
    // Barra de progreso
    const progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    const progressFill = document.createElement('div');
    progressFill.className = 'progress-fill';
    progressBar.appendChild(progressFill);
    
    // Actualizar progreso
    audio.addEventListener('timeupdate', function() {
        const percent = (audio.currentTime / audio.duration) * 100;
        progressFill.style.width = percent + '%';
    });
    
    // Click en barra de progreso para buscar
    progressBar.onclick = function(e) {
        const rect = progressBar.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        audio.currentTime = percent * audio.duration;
    };
    
    // Cuando termina el audio
    audio.addEventListener('ended', function() {
        playPauseBtn.textContent = '▶';
    });
    
    // Ensamblar la pista
    trackDiv.appendChild(trackHeader);
    trackDiv.appendChild(trackControls);
    trackDiv.appendChild(progressBar);
    
    // Agregar al mezclador
    mixerTracks.appendChild(trackDiv);
    audioContainer.classList.add('active');
    
    // Guardar referencia (incluyendo el marcador)
    activeAudios.set(location.id, { 
        element: trackDiv, 
        audio: audio,
        marker: location.marker 
    });
    
    // Actualizar color del marcador a activo
    updateMarkerStyle(location.marker, true);
    
    // Reproducir automáticamente
    audio.play().catch(err => console.log('Error al reproducir:', err));
}

// Función para actualizar el icono de volumen
function updateVolumeIcon(icon, value) {
    // Limpiar clases existentes
    icon.className = 'volume-icon';
    
    if (value == 0) {
        icon.classList.add('fas', 'fa-volume-mute');
    } else if (value < 50) {
        icon.classList.add('fas', 'fa-volume-down');
    } else {
        icon.classList.add('fas', 'fa-volume-up');
    }
}

// Función para eliminar una pista de audio
function removeAudioTrack(locationId) {
    const audioData = activeAudios.get(locationId);
    if (audioData) {
        audioData.audio.pause();
        audioData.element.remove();
        
        // Restaurar color del marcador a inactivo
        if (audioData.marker) {
            updateMarkerStyle(audioData.marker, false);
        }
        
        activeAudios.delete(locationId);
        
        // Ocultar mezclador si no hay más audios
        if (activeAudios.size === 0) {
            audioContainer.classList.remove('active');
        }
    }
}

// Función para actualizar el estilo del marcador
function updateMarkerStyle(marker, isActive) {
    if (!marker) return;
    const iconElement = marker.getElement();
    if (iconElement) {
        const circle = iconElement.querySelector('.marker-core');
        const badgeIcon = iconElement.querySelector('.media-badge i');
        const badge = iconElement.querySelector('.media-badge');
        // Only change the media badge when toggling active state.
        // Do NOT alter the main category marker colors here (user preference).
        if (badge) {
            // If the location has no file, always keep the badge gray
            const isMissingFile = badgeIcon && badgeIcon.style.color === '#888';
            if (isActive) {
                // badge goes gray when active
                if (badgeIcon) badgeIcon.style.color = '#6b7280';
                badge.style.borderColor = '#6b7280';
                badge.style.background = '#ffffff';
            } else {
                if (isMissingFile) {
                    // keep gray if missing file
                    if (badgeIcon) badgeIcon.style.color = '#888';
                    badge.style.borderColor = '#888';
                    badge.style.background = '#ffffff';
                } else {
                    // restore badge to the category color
                    const orig = marker._origColor || '#666';
                    if (badgeIcon) badgeIcon.style.color = orig;
                    badge.style.borderColor = orig;
                    badge.style.background = '#ffffff';
                }
            }
        }
    }
}

// Cargar ubicaciones desde el JSON
fetch('locations.json')
    .then(response => response.json())
    .then(locations => {
        // Mapa de iconos por categoría (íconos más descriptivos)
        const categoryMap = {
            // Colores distintos por categoría (más contrastados entre sí)
            'Sonidos objetos': { icon: 'fa-box-open', color: '#6366F1' }, // indigo
            'Cantantes o instrumentos': { icon: 'fa-guitar', color: '#06B6D4' }, // cyan/teal
            'Eventos': { icon: 'fa-calendar-check', color: '#F59E0B' }, // amber
            'Bailadores': { icon: 'fa-theater-masks', color: '#EF4444' }, // performers/dancers
            'Vendedores': { icon: 'fa-store', color: '#7C3AED' }, // violet (differentiador)
            'Sonidos Naturales': { icon: 'fa-tree', color: '#10B981' }, // green
            'Lugares': { icon: 'fa-landmark', color: '#2563EB' } // azul para lugares
        };

        // Estado de categorías habilitadas (por defecto todas activas)
        const enabledCategories = {};
        Object.keys(categoryMap).forEach(cat => {
            enabledCategories[cat] = true;
        });

        // Inicializar la leyenda usando categoryMap
        const legend = document.getElementById('map-legend');
        const legendBody = document.getElementById('legend-body');

        function buildLegend() {
            // Vaciar contenedor de items para reconstruir
            const legendItems = document.getElementById('legend-items');
            if (!legendItems) return;
            legendItems.innerHTML = '';
            Object.keys(categoryMap).forEach(cat => {
                const info = categoryMap[cat];
                const row = document.createElement('div');
                row.className = 'legend-row';
                row.dataset.category = cat;
                
                // Aplicar clase disabled si la categoría está deshabilitada
                if (!enabledCategories[cat]) {
                    row.classList.add('disabled');
                }

                // Checkmark visual
                const checkmark = document.createElement('div');
                checkmark.className = 'legend-checkmark';
                checkmark.innerHTML = '<i class="fas fa-check"></i>';

                const iconBox = document.createElement('div');
                iconBox.className = 'legend-icon';
                iconBox.style.background = info.color;
                iconBox.innerHTML = `<i class="fas ${info.icon}"></i>`;

                const label = document.createElement('div');
                label.className = 'legend-label';
                label.textContent = cat;
                label.style.flex = '1';

                // Agregar click handler para toggle de categoría
                row.addEventListener('click', function() {
                    toggleCategory(cat);
                });

                row.appendChild(checkmark);
                row.appendChild(iconBox);
                row.appendChild(label);
                legendItems.appendChild(row);
            });
        }

        // Función para toggle de categorías
        function toggleCategory(category) {
            // Cambiar el estado de la categoría
            enabledCategories[category] = !enabledCategories[category];
            
            // Actualizar la apariencia de la leyenda
            buildLegend();
            
            // Actualizar la visibilidad de los marcadores
            updateMarkersVisibility();
        }

        // Función para actualizar la visibilidad de los marcadores según las categorías habilitadas
        function updateMarkersVisibility() {
            locations.forEach(location => {
                if (!location.marker) return;
                
                const category = location.category || 'Uncategorized';
                const isEnabled = enabledCategories[category];
                
                if (isEnabled) {
                    // Mostrar marcador
                    if (!map.hasLayer(location.marker)) {
                        location.marker.addTo(map);
                    }
                } else {
                    // Ocultar marcador
                    if (map.hasLayer(location.marker)) {
                        map.removeLayer(location.marker);
                        
                        // Si este marcador tenía audio activo, eliminarlo del mixer
                        if (location.type === 'audio' && activeAudios.has(location.id)) {
                            removeAudioTrack(location.id);
                        }
                        
                        // Si este marcador tenía video abierto, cerrarlo
                        if (location.type === 'video' && currentVideoMarker === location.marker) {
                            closeVideoPanel();
                        }
                    }
                }
            });
        }

        // Hover behavior: show legend on hover of the layers control, hide when leaving
        let legendHideTimer = null;
        function showLegend() {
            if (legendHideTimer) { clearTimeout(legendHideTimer); legendHideTimer = null; }

            try {
                const legendBtn = document.getElementById('legend-btn');
                if (legendBtn) {
                    const btnRect = legendBtn.getBoundingClientRect();
                    const legendWidth = Math.min(320, Math.floor(window.innerWidth * 0.9));
                    // set width first so height measurement is correct
                    legend.style.width = legendWidth + 'px';

                    // Make legend active (but hidden) to measure its height
                    legend.classList.add('active');
                    legend.style.visibility = 'hidden';
                    const lh = legend.offsetHeight || 150;

                    // Compute left so legend is centered above the button but stays within viewport
                    let left = Math.round(btnRect.left + btnRect.width / 2 - legendWidth / 2);
                    left = Math.max(8, Math.min(left, window.innerWidth - legendWidth - 8));

                    // Compute top so legend overlaps the button (covers it partially)
                    // Position legend so its bottom sits slightly below the button center
                    let top = Math.round(btnRect.top + btnRect.height / 2 - lh);
                    // Ensure it doesn't go off the top of the viewport
                    top = Math.max(8, top);

                    legend.style.left = left + 'px';
                    legend.style.top = top + 'px';
                    // remove temporary hidden flag so it becomes visible
                    legend.style.visibility = '';
                } else {
                    legend.classList.add('active');
                }
            } catch (err) {
                console.warn('No se pudo posicionar la leyenda dinámicamente', err);
                legend.classList.add('active');
            }

            // hide the legend button while legend is visible (so the legend covers it)
            try {
                const lb = document.getElementById('legend-btn');
                if (lb) lb.style.display = 'none';
            } catch (err) {}

            legend.setAttribute('aria-hidden', 'false');
        }
        function hideLegendSoon() {
            if (legendHideTimer) clearTimeout(legendHideTimer);
            legendHideTimer = setTimeout(() => {
                legend.classList.remove('active');
                legend.setAttribute('aria-hidden', 'true');
                // restore the legend button visibility when legend is hidden
                try {
                    const lb = document.getElementById('legend-btn');
                    if (lb) lb.style.display = '';
                } catch (err) {}
            }, 300);
        }

        // Attach hover listeners to the layer control container to open the layers menu on hover
        // and keep legend behavior independent via its own button
        try {
            const layersContainer = layerControl.getContainer();
            // Open layers menu when hovering
            let layersCloseTimer = null;
            layersContainer.addEventListener('mouseenter', () => {
                if (layersCloseTimer) { clearTimeout(layersCloseTimer); layersCloseTimer = null; }
                layersContainer.classList.add('leaflet-control-layers-expanded');
            });
            layersContainer.addEventListener('mouseleave', () => {
                if (layersCloseTimer) clearTimeout(layersCloseTimer);
                layersCloseTimer = setTimeout(() => {
                    layersContainer.classList.remove('leaflet-control-layers-expanded');
                }, 250);
            });

            // Legend button shows legend independently
            const legendBtn = document.getElementById('legend-btn');
            if (legendBtn) {
                legendBtn.addEventListener('mouseenter', showLegend);
                legendBtn.addEventListener('mouseleave', hideLegendSoon);
            }
        } catch (err) {
            console.warn('No se pudo enlazar hover con layerControl:', err);
        }

        legend.addEventListener('mouseenter', () => { if (legendHideTimer) { clearTimeout(legendHideTimer); legendHideTimer = null; } });
        legend.addEventListener('mouseleave', hideLegendSoon);

                // Nota: el botón de cierre de la leyenda fue removido; cerrar se hace con mouseleave o programáticamente

        // Construir leyenda la primera vez
        buildLegend();

        locations.forEach(location => {
            const category = location.category || 'Uncategorized';
            const catInfo = categoryMap[category] || { icon: 'fa-map-marker-alt', color: '#666' };

            // Si no hay lat/lng, no creamos marcador (el usuario agregará coordenadas más tarde)
            if (!location.lat || !location.lng) {
                // Guardar la ubicación sin marcador (se puede listar en UI más adelante)
                location.marker = null;
                return;
            }

            // Crear html del icono según la categoría
                let iconColor = catInfo.color;
                let badgeColor = catInfo.color;
                if (!location.file) {
                    iconColor = '#888';
                    badgeColor = '#888';
                }
                const iconHTML = `<i class="fas ${catInfo.icon}" style="color: ${iconColor};"></i>`;
                let badgeHTML = '';
                if (location.file) {
                    const mediaIcon = location.type === 'video' ? 'fa-video' : (location.type === 'audio' ? 'fa-volume-up' : '');
                    if (mediaIcon) {
                        badgeHTML = `<div class="media-badge" style="border-color: ${badgeColor};"><i class="fas ${mediaIcon}" style="color: ${badgeColor};"></i></div>`;
                    }
                }

            const customIcon = L.divIcon({
                className: 'custom-marker',
                html: `
                    <div style="position:relative; display:inline-block;">
                        <div class="marker-core" style="border-color: ${catInfo.color}; color: ${catInfo.color};">
                            ${iconHTML}
                        </div>
                        ${badgeHTML}
                    </div>
                `,
                iconSize: [36, 36],
                iconAnchor: [18, 18],
                popupAnchor: [0, -18]
            });

            // Crear marcador con icono personalizado
            const marker = L.marker([location.lat, location.lng], { icon: customIcon }).addTo(map);
            // Guardar el color original del marcador para restaurarlo luego
            marker._origColor = catInfo.color;
            location.marker = marker;

            // No popup for videos: usaremos un panel lateral no bloqueante para reproducir video

            // Click en marcador: si es audio, añadir al mezclador; si es video, abrir en el panel lateral
            marker.on('click', function(e) {
                if (location.type === 'audio') {
                    L.DomEvent.stopPropagation(e);
                    createAudioTrack(location);
                    return false;
                }
                if (location.type === 'video') {
                    L.DomEvent.stopPropagation(e);
                    openVideoPanel(location, marker);
                    return false;
                }
            });
        });

        // Crear máscara circular invertida centrada en Capuchina
        try {
            console.log('Iniciando creación de máscara circular...');
            const locCoords = locations.filter(l => l.lat && l.lng).map(l => L.latLng(l.lat, l.lng));
            console.log('Ubicaciones con coordenadas:', locCoords.length);
            
            if (locCoords.length) {
                // Centro ajustado: mucho más a la derecha (lng más positivo = este)
                const center = L.latLng(4.604169891807999, -74.07385381204059);
                console.log('Centro del círculo:', center.toString());

                // Calcular la distancia máxima desde el centro a cualquier ubicación (metros)
                let maxDist = 0;
                locCoords.forEach(ll => {
                    const d = map.distance(center, ll);
                    if (d > maxDist) maxDist = d;
                });

                // Reducir el radio: padding del 3% (más chico)
                const radius = Math.ceil(maxDist * 1.25);
                console.log('Radio calculado:', radius, 'metros (', Math.round(radius), 'm )');

                // PRIMERO: Dibujar el círculo visible (contorno blanco)
                outsideCircleOutline = L.circle(center, {
                    radius: radius,
                    color: '#ffffff',
                    weight: 3,
                    opacity: 1,
                    fill: false,
                    interactive: false
                }).addTo(map);
                console.log('Contorno del círculo añadido al mapa');

                // SEGUNDO: Crear la máscara invertida (oscurecer afuera)
                // Generar puntos del círculo manualmente para mayor control
                const circlePoints = [];
                const steps = 64;
                for (let i = 0; i <= steps; i++) {
                    const angle = (i / steps) * 2 * Math.PI;
                    const dx = radius * Math.cos(angle);
                    const dy = radius * Math.sin(angle);
                    
                    // Calcular lat/lng del punto en el círculo
                    const earthRadius = 6371000; // metros
                    const dLat = (dy / earthRadius) * (180 / Math.PI);
                    const dLng = (dx / (earthRadius * Math.cos(center.lat * Math.PI / 180))) * (180 / Math.PI);
                    
                    circlePoints.push([center.lat + dLat, center.lng + dLng]);
                }

                // Invertir puntos para crear agujero
                const innerRing = circlePoints.reverse();

                // Polígono grande (mundo) para crear el efecto de máscara invertida
                const worldBounds = [
                    [85, -180], [85, 180], [-85, 180], [-85, -180], [85, -180]
                ];

                // Si ya hay una máscara previa, eliminarla
                if (outsideCircleMask && map.hasLayer(outsideCircleMask)) {
                    map.removeLayer(outsideCircleMask);
                }

                outsideCircleMask = L.polygon([worldBounds, innerRing], {
                    color: 'transparent',
                    fillColor: '#000',
                    fillOpacity: 0.65,
                    interactive: false
                }).addTo(map);
                console.log('Máscara invertida añadida al mapa');

                // Traer al frente ambas capas
                setTimeout(() => {
                    try { 
                        if (outsideCircleMask) outsideCircleMask.bringToFront(); 
                    } catch (e) { console.warn('No se pudo traer máscara al frente:', e); }
                    
                    try { 
                        if (outsideCircleOutline) outsideCircleOutline.bringToFront(); 
                    } catch (e) { console.warn('No se pudo traer contorno al frente:', e); }
                }, 100);

                console.log('✓ Máscara circular completada');

                // CARGAR ZONAS VERDES dentro del círculo
                // Calcular bbox desde el centro y radio del círculo
                const earthRadius = 6371000; // metros
                const dLat = (radius / earthRadius) * (180 / Math.PI);
                const dLng = (radius / (earthRadius * Math.cos(center.lat * Math.PI / 180))) * (180 / Math.PI);
                
                const circleBbox = {
                    south: center.lat - dLat,
                    north: center.lat + dLat,
                    west: center.lng - dLng,
                    east: center.lng + dLng
                };

                console.log('Cargando zonas verdes dentro del círculo, bbox:', circleBbox);
                
                // Guardar coordenadas del círculo para filtrado (en formato [lng, lat])
                const circlePolygonCoords = circlePoints.map(p => [p[1], p[0]]); // swap to [lng, lat]
                delimPolygonsCoordsLonLat = [circlePolygonCoords];
                
                loadGreenAreas(circleBbox);
            } else {
                console.warn('No hay ubicaciones con coordenadas válidas');
            }
        } catch (err) {
            console.error('Error creando la máscara circular:', err);
        }
    })
    .catch(error => {
        console.error('Error al cargar las ubicaciones:', error);
    });