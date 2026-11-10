import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import * as EsriLeaflet from "esri-leaflet";
import "leaflet/dist/leaflet.css";

type Project = {
  id: number; organization_id: number; name: string; description: string | null;
  project_type: string; status: string; created_at: string;
};
type GISWorkspaceProps = { projects: Project[] };
type Dataset = {
  id: number; project_id: number; name: string; description?: string | null;
  source_format?: string | null; source_filename?: string | null; geometry_type?: string | null;
  crs?: string | null; status?: string | null;
};
type SavedMap = {
  id: number; project_id: number; name: string; description?: string | null;
  configuration: MapConfiguration; created_at?: string; updated_at?: string;
};
type LayerConfig = { key: string; kind: "dataset" | "pipelines"; dataset_id?: number; name: string; visible: boolean; color: string; opacity: number; weight: number };
type MapConfiguration = { basemap: string; center: [number, number]; zoom: number; layers: LayerConfig[] };
type FeatureProperties = Record<string, unknown>;
type FeatureCollectionResponse = { type: "FeatureCollection"; dataset_id: number; dataset_name: string; crs: string; total_features: number; features: GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>[] };

const API = "http://127.0.0.1:8000";
const PIPELINES_URL = "https://www.gis.hctx.net/arcgishcpid/rest/services/TXRRC/Pipelines/MapServer/0";
const COLORS = ["#22c55e", "#38bdf8", "#f59e0b", "#a78bfa", "#f472b6", "#fb7185", "#14b8a6"];
const initialLayers: LayerConfig[] = [{ key: "pipelines", kind: "pipelines", name: "Oil & gas pipelines", visible: true, color: "#f59e0b", opacity: 0.9, weight: 3 }];
const initialConfig: MapConfiguration = { basemap: "OpenStreetMap", center: [29.7604, -95.3698], zoom: 10, layers: initialLayers };

function normalizeConfig(value: unknown): MapConfiguration {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<MapConfiguration>;
  const center = Array.isArray(raw.center) && raw.center.length === 2 ? raw.center : initialConfig.center;
  const layers = Array.isArray(raw.layers) ? raw.layers.filter((x): x is LayerConfig => !!x && typeof x === "object" && typeof (x as LayerConfig).key === "string") : initialLayers;
  return { basemap: raw.basemap === "Esri World Imagery" ? raw.basemap : "OpenStreetMap", center: [Number(center[0]), Number(center[1])], zoom: Number(raw.zoom) || 10, layers };
}
function escapeHtml(value: unknown) { return String(value ?? "No disponible").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }

export default function GISWorkspace({ projects }: GISWorkspaceProps) {
  const [projectId, setProjectId] = useState("");
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [savedMaps, setSavedMaps] = useState<SavedMap[]>([]);
  const [layers, setLayers] = useState<LayerConfig[]>(initialLayers);
  const [basemap, setBasemap] = useState(initialConfig.basemap);
  const [status, setStatus] = useState("Selecciona un proyecto para cargar sus datasets.");
  const [mapName, setMapName] = useState("");
  const [mapDescription, setMapDescription] = useState("");
  const [selectedMapId, setSelectedMapId] = useState("");
  const [datasetToAdd, setDatasetToAdd] = useState("");
  const [uploadName, setUploadName] = useState("");
  const [uploadDescription, setUploadDescription] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [selectedFeature, setSelectedFeature] = useState<FeatureProperties | null>(null);
  const mapElement = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const renderedLayers = useRef<Map<string, L.Layer>>(new Map());
  const layerConfigRef = useRef(layers);
  layerConfigRef.current = layers;
  const selectedProject = projects.find(p => String(p.id) === projectId);

  useEffect(() => {
    if (!projects.length) { setProjectId(""); return; }
    setProjectId(current => current && projects.some(p => String(p.id) === current) ? current : String(projects[0].id));
  }, [projects]);

  const request = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(`${API}${url}`, init);
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try { const body = await response.json(); detail = body.detail || detail; } catch { /* response may not be JSON */ }
      throw new Error(detail);
    }
    return response.status === 204 ? null : response.json();
  }, []);

  const refreshCatalog = useCallback(async (id: string) => {
    if (!id) { setDatasets([]); setSavedMaps([]); return; }
    try {
      const [datasetRows, mapRows] = await Promise.all([
        request(`/api/v1/datasets?project_id=${encodeURIComponent(id)}`),
        request(`/api/v1/projects/${id}/maps`),
      ]);
      setDatasets(Array.isArray(datasetRows) ? datasetRows : []);
      setSavedMaps(Array.isArray(mapRows) ? mapRows : []);
      setStatus(`Catálogo actualizado: ${(datasetRows || []).length} datasets y ${(mapRows || []).length} mapas guardados.`);
    } catch (e) { setStatus(`No se pudo cargar el catálogo: ${e instanceof Error ? e.message : String(e)}`); }
  }, [request]);

  useEffect(() => { void refreshCatalog(projectId); }, [projectId, refreshCatalog]);

  useEffect(() => {
    if (!mapElement.current || mapRef.current) return;
    const map = L.map(mapElement.current, { center: initialConfig.center, zoom: initialConfig.zoom, zoomControl: false });
    mapRef.current = map;
    L.control.zoom({ position: "topright" }).addTo(map);
    tileRef.current = createBasemap(basemap).addTo(map);
    const timer = window.setTimeout(() => map.invalidateSize(), 200);
    return () => { window.clearTimeout(timer); map.remove(); mapRef.current = null; tileRef.current = null; renderedLayers.current.clear(); };
    // Basemap changes are handled by a separate effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileRef.current) map.removeLayer(tileRef.current);
    tileRef.current = createBasemap(basemap).addTo(map);
  }, [basemap]);

  const drawDataset = useCallback(async (config: LayerConfig): Promise<L.Layer> => {
    const response = await request(`/api/v1/datasets/${config.dataset_id}/features?limit=5000&offset=0`) as FeatureCollectionResponse;
    if (response.type !== "FeatureCollection" || !Array.isArray(response.features)) throw new Error(`El dataset ${config.name} no devolvió GeoJSON válido.`);
    return L.geoJSON(response as GeoJSON.GeoJsonObject, {
      style: () => ({ color: config.color, weight: config.weight, opacity: config.opacity, fillColor: config.color, fillOpacity: Math.min(0.35, config.opacity * 0.3) }),
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 6, color: config.color, weight: config.weight, fillColor: config.color, fillOpacity: config.opacity }),
      onEachFeature: (feature, featureLayer) => {
        const properties = (feature.properties ?? {}) as FeatureProperties;
        featureLayer.on("click", () => setSelectedFeature(properties));
        const rows = Object.entries(properties).slice(0, 20).map(([key, value]) => `<div style="margin-bottom:5px"><strong>${escapeHtml(key)}</strong>: ${escapeHtml(value)}</div>`).join("");
        featureLayer.bindPopup(`<div style="max-height:240px;overflow:auto">${rows || "No hay atributos disponibles"}</div>`);
      },
    });
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    const map = mapRef.current;
    if (!map) return;
    async function syncLayers() {
      const configs = layerConfigRef.current;
      const activeKeys = new Set(configs.map(layer => layer.key));
      for (const [key, rendered] of renderedLayers.current.entries()) {
        if (!activeKeys.has(key)) { map.removeLayer(rendered); renderedLayers.current.delete(key); }
      }
      for (const config of configs) {
        try {
          let rendered = renderedLayers.current.get(config.key);
          if (!rendered) {
            if (config.kind === "pipelines") {
              const pipeline = EsriLeaflet.featureLayer({ url: PIPELINES_URL, style: () => ({ color: config.color, weight: config.weight, opacity: config.opacity }) });
              pipeline.on("click", (event: L.LeafletMouseEvent & { layer?: L.Layer & { feature?: { properties?: FeatureProperties }; bindPopup?: (content: string) => L.Layer; openPopup?: () => L.Layer } }) => {
                const props = event.layer?.feature?.properties ?? {}; setSelectedFeature(props);
                const rows = Object.entries(props).slice(0, 20).map(([key, value]) => `<div style="margin-bottom:5px"><strong>${escapeHtml(key)}</strong>: ${escapeHtml(value)}</div>`).join("");
                event.layer?.bindPopup?.(`<div style="max-height:240px;overflow:auto">${rows || "No hay atributos disponibles"}</div>`).openPopup?.();
              });
              rendered = pipeline;
            } else if (config.dataset_id) rendered = await drawDataset(config);
            else continue;
            if (cancelled) { map.removeLayer(rendered); return; }
            renderedLayers.current.set(config.key, rendered);
          }
          const shouldShow = config.visible;
          if (shouldShow && !map.hasLayer(rendered)) rendered.addTo(map);
          if (!shouldShow && map.hasLayer(rendered)) map.removeLayer(rendered);
          // Reaplicar la simbología en cada cambio de configuración.
          // Leaflet GeoJSON admite setStyle; Esri Leaflet FeatureLayer también expone setStyle.
          const style = {
            color: config.color,
            weight: config.weight,
            opacity: config.opacity,
            fillColor: config.color,
            fillOpacity: Math.min(0.35, config.opacity * 0.3),
          };
          if (config.kind === "dataset" && rendered instanceof L.GeoJSON) {
            rendered.setStyle(style);
          } else if (config.kind === "pipelines") {
            const esriLayer = rendered as L.Layer & { setStyle?: (style: L.PathOptions | ((feature?: unknown) => L.PathOptions)) => unknown };
            esriLayer.setStyle?.({ color: config.color, weight: config.weight, opacity: config.opacity });
          }
        } catch (e) { if (!cancelled) setStatus(`Error en la capa «${config.name}»: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
    void syncLayers();
    return () => { cancelled = true; };
  }, [layers, drawDataset]);

  function updateLayer(key: string, patch: Partial<LayerConfig>) { setLayers(current => current.map(layer => layer.key === key ? { ...layer, ...patch } : layer)); }
  function addDataset() {
    const id = Number(datasetToAdd); const dataset = datasets.find(d => d.id === id);
    if (!dataset) return;
    if (layers.some(layer => layer.kind === "dataset" && layer.dataset_id === id)) { setStatus("Ese dataset ya está en la composición del mapa."); return; }
    const color = COLORS[layers.length % COLORS.length];
    setLayers(current => [...current, { key: `dataset-${id}`, kind: "dataset", dataset_id: id, name: dataset.name, visible: true, color, opacity: 0.9, weight: 2 }]);
    setDatasetToAdd(""); setStatus(`Añadido «${dataset.name}» a la composición. El dataset original no se ha modificado.`);
  }
  function removeFromMap(key: string) {
    const item = layers.find(layer => layer.key === key);
    setLayers(current => current.filter(layer => layer.key !== key));
    setStatus(`Capa «${item?.name ?? key}» retirada del mapa. Los datos originales permanecen en la base de datos.`);
  }
  function moveLayer(index: number, delta: number) {
    setLayers(current => { const next = [...current]; const target = index + delta; if (target < 0 || target >= next.length) return current; [next[index], next[target]] = [next[target], next[index]]; return next; });
  }
  function captureConfig(): MapConfiguration {
    const map = mapRef.current; const center = map?.getCenter();
    return { basemap, center: center ? [center.lat, center.lng] : initialConfig.center, zoom: map?.getZoom() ?? initialConfig.zoom, layers: layers.map(layer => ({ ...layer })) };
  }
  async function saveMap(asNew: boolean) {
    if (!projectId) { setStatus("Selecciona un proyecto antes de guardar."); return; }
    if (!asNew && !selectedMapId) {
      setStatus("No hay un mapa guardado seleccionado. Usa «Guardar como mapa nuevo» para crear la primera configuración.");
      return;
    }
    const name = mapName.trim();
    if (!name) { setStatus("Escribe un nombre para el mapa antes de guardarlo."); return; }
    const payload = { name, description: mapDescription.trim() || null, configuration: captureConfig() };
    setStatus(asNew ? "Creando una nueva configuración…" : "Guardando cambios en el mapa seleccionado…");
    try {
      const saved = await request(
        asNew ? `/api/v1/projects/${projectId}/maps` : `/api/v1/maps/${selectedMapId}`,
        { method: asNew ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      ) as SavedMap;
      setSelectedMapId(String(saved.id));
      setMapName(saved.name);
      setMapDescription(saved.description ?? "");
      const [datasetRows, mapRows] = await Promise.all([
        request(`/api/v1/datasets?project_id=${encodeURIComponent(projectId)}`),
        request(`/api/v1/projects/${projectId}/maps`),
      ]);
      setDatasets(Array.isArray(datasetRows) ? datasetRows : []);
      setSavedMaps(Array.isArray(mapRows) ? mapRows : []);
      setStatus(asNew
        ? `Nuevo mapa «${saved.name}» guardado correctamente (ID ${saved.id}). Ya puedes seleccionarlo y volver a abrirlo.`
        : `Cambios guardados en «${saved.name}» (ID ${saved.id}).`);
    } catch (e) {
      setStatus(`No se pudo ${asNew ? "crear el mapa" : "guardar los cambios"}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function loadMap() {
    if (!selectedMapId) { setStatus("Selecciona un mapa guardado."); return; }
    try {
      const saved = await request(`/api/v1/maps/${selectedMapId}`) as SavedMap;
      if (String(saved.project_id) !== projectId) { setStatus("El mapa seleccionado pertenece a otro proyecto."); return; }
      const config = normalizeConfig(saved.configuration);
      setLayers(config.layers); setBasemap(config.basemap); setMapName(saved.name); setMapDescription(saved.description ?? "");
      const map = mapRef.current; if (map) map.setView(config.center, config.zoom);
      setStatus(`Mapa «${saved.name}» cargado. Puedes modificarlo y guardar los cambios o guardarlo con otro nombre.`);
    } catch (e) { setStatus(`No se pudo abrir el mapa: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async function deleteMap() {
    if (!selectedMapId || !window.confirm("¿Eliminar esta configuración de mapa? Los datasets y sus datos espaciales NO se borrarán.")) return;
    try {
      await request(`/api/v1/maps/${selectedMapId}`, { method: "DELETE" });
      setSelectedMapId(""); setMapName(""); setMapDescription(""); await refreshCatalog(projectId);
      setStatus("Configuración eliminada. Los datasets y las tablas espaciales siguen intactos.");
    } catch (e) { setStatus(`No se pudo eliminar la configuración: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async function uploadDataset(event: ChangeEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || !uploadFile || uploadName.trim().length < 2) { setStatus("Selecciona un archivo y escribe un nombre de al menos 2 caracteres."); return; }
    const form = new FormData(); form.append("project_id", projectId); form.append("name", uploadName.trim()); form.append("description", uploadDescription.trim()); form.append("file", uploadFile);
    try {
      const created = await request("/api/v1/datasets/upload", { method: "POST", body: form }) as Dataset;
      await refreshCatalog(projectId);
      const key = `dataset-${created.id}`;
      setLayers(current => current.some(layer => layer.key === key) ? current : [...current, { key, kind: "dataset", dataset_id: created.id, name: created.name, visible: true, color: COLORS[current.length % COLORS.length], opacity: 0.9, weight: 2 }]);
      setUploadName(""); setUploadDescription(""); setUploadFile(null); event.currentTarget.reset();
      setStatus(`Dataset «${created.name}» importado y añadido al mapa.`);
    } catch (e) { setStatus(`No se pudo importar el archivo: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const availableDatasets = useMemo(() => datasets.filter(dataset => !layers.some(layer => layer.kind === "dataset" && layer.dataset_id === dataset.id)), [datasets, layers]);

  return <div className="gis-workspace">
    <div className="gis-toolbar"><div><div className="gis-eyebrow">SPATIAL ANALYSIS / GIS WORKSPACE</div><h1>{selectedProject?.name ?? "GIS Workspace"}</h1><p>Gestiona datasets, capas y composiciones cartográficas guardadas.</p></div>
      <div className="gis-coordinate"><label htmlFor="gis-project-select" style={labelStyle}>PROYECTO ACTIVO</label><select id="gis-project-select" value={projectId} onChange={e => { setProjectId(e.target.value); setSelectedMapId(""); setMapName(""); setMapDescription(""); setLayers(initialLayers); setBasemap("OpenStreetMap"); }} disabled={!projects.length} style={inputStyle}>{projects.length ? projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>) : <option value="">No hay proyectos</option>}</select><span style={{ display: "block" }}>CAPAS EN MAPA</span><strong>{layers.length}</strong></div>
    </div>
    <div style={toolbarPanelStyle}>
      <div style={controlGroupStyle}><label style={labelStyle} htmlFor="saved-map-select">MAPAS GUARDADOS</label><select id="saved-map-select" value={selectedMapId} onChange={e => { setSelectedMapId(e.target.value); const item = savedMaps.find(m => String(m.id) === e.target.value); if (item) { setMapName(item.name); setMapDescription(item.description ?? ""); } }} style={inputStyle}><option value="">Seleccionar mapa...</option>{savedMaps.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><button type="button" style={buttonStyle} onClick={() => void loadMap()}>Abrir</button><button type="button" style={dangerButtonStyle} onClick={() => void deleteMap()} disabled={!selectedMapId}>Eliminar configuración</button></div>
      <div style={controlGroupStyle}><label style={labelStyle} htmlFor="map-name">NOMBRE DEL MAPA</label><input id="map-name" value={mapName} onChange={e => setMapName(e.target.value)} placeholder="Ej. Infraestructura energética" style={inputStyle}/><input value={mapDescription} onChange={e => setMapDescription(e.target.value)} placeholder="Descripción (opcional)" style={inputStyle}/><button type="button" style={buttonStyle} onClick={() => void saveMap(false)} disabled={!selectedMapId} title={!selectedMapId ? "Primero abre un mapa guardado; para crear uno usa Guardar como mapa nuevo" : "Actualizar la configuración seleccionada"}>Guardar cambios del mapa actual</button><button type="button" style={buttonStyle} onClick={() => void saveMap(true)}>Guardar como mapa nuevo</button></div>
    </div>
    <div className="gis-layout"><aside className="gis-layer-panel"><div className="gis-panel-title"><span>CONTENIDO DEL MAPA</span><strong>Capas ({layers.length})</strong></div>
      <div style={{ marginBottom: 18 }}><label htmlFor="add-dataset" style={labelStyle}>AÑADIR DATASET EXISTENTE</label><select id="add-dataset" value={datasetToAdd} onChange={e => setDatasetToAdd(e.target.value)} style={{ ...inputStyle, width: "100%", marginTop: 7 }}><option value="">Seleccionar dataset...</option>{availableDatasets.map(d => <option key={d.id} value={d.id}>{d.name} (#{d.id})</option>)}</select><button type="button" style={{ ...buttonStyle, width: "100%", marginTop: 7 }} onClick={addDataset} disabled={!datasetToAdd}>Añadir al mapa</button></div>
      {layers.map((layer, index) => <div key={layer.key} style={layerCardStyle}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><input aria-label={`Visibilidad de ${layer.name}`} type="checkbox" checked={layer.visible} onChange={e => updateLayer(layer.key, { visible: e.target.checked })}/><span className="gis-layer-symbol" style={{ backgroundColor: layer.color }}/><strong style={{ flex: 1, fontSize: 12 }}>{layer.name}</strong></div><div style={{ display: "flex", gap: 5, marginTop: 8, flexWrap: "wrap" }}><button style={smallButtonStyle} onClick={() => moveLayer(index, -1)} disabled={index === 0} title="Subir capa">↑</button><button style={smallButtonStyle} onClick={() => moveLayer(index, 1)} disabled={index === layers.length - 1} title="Bajar capa">↓</button><button style={smallButtonStyle} onClick={() => removeFromMap(layer.key)}>Quitar del mapa</button></div><div style={styleGrid}><label style={miniLabelStyle}>Color <input type="color" value={layer.color} onChange={e => updateLayer(layer.key, { color: e.target.value })}/></label><label style={miniLabelStyle}>Opacidad <input type="range" min="0.1" max="1" step="0.1" value={layer.opacity} onChange={e => updateLayer(layer.key, { opacity: Number(e.target.value) })}/></label><label style={miniLabelStyle}>Grosor <input type="range" min="1" max="6" step="1" value={layer.weight} onChange={e => updateLayer(layer.key, { weight: Number(e.target.value) })}/></label></div><small style={{ color: "#94a3b8" }}>{layer.kind === "dataset" ? `Dataset #${layer.dataset_id}` : "Servicio externo Harris County / TXRRC"}</small></div>)}
      <form onSubmit={uploadDataset} style={{ borderTop: "1px solid #263449", paddingTop: 16, marginTop: 16 }}><strong style={{ display: "block", marginBottom: 10 }}>Importar archivo GIS</strong><label style={miniLabelStyle}>Nombre<input required minLength={2} value={uploadName} onChange={e => setUploadName(e.target.value)} style={inputStyle} placeholder="Nombre del dataset"/></label><label style={miniLabelStyle}>Descripción<input value={uploadDescription} onChange={e => setUploadDescription(e.target.value)} style={inputStyle} placeholder="Descripción opcional"/></label><label style={miniLabelStyle}>Archivo (.zip, .geojson, .json, .gpkg)<input required type="file" accept=".zip,.geojson,.json,.gpkg" onChange={e => setUploadFile(e.target.files?.[0] ?? null)} style={{ ...inputStyle, width: "100%" }}/></label><button type="submit" style={{ ...buttonStyle, width: "100%" }} disabled={!projectId || !uploadFile}>Importar y añadir al mapa</button><small style={{ color: "#94a3b8", display: "block", marginTop: 6 }}>La importación crea un dataset nuevo en el proyecto activo.</small></form>
      <div className="gis-data-notice" style={{ marginTop: 16 }}><strong>Estado</strong><p>{status}</p><p>Quitar una capa solo modifica la composición del mapa. No borra el dataset ni sus datos espaciales.</p></div>
      {selectedFeature && <div className="gis-data-notice"><strong>Atributos seleccionados</strong><div style={{ marginTop: 8, color: "#a6b5c8", fontSize: 11, lineHeight: 1.6, overflowWrap: "anywhere" }}>{Object.entries(selectedFeature).slice(0, 20).map(([key, value]) => <div key={key}><strong>{key}:</strong> {String(value ?? "—")}</div>)}</div></div>}
      <div className="gis-map-legend"><span>MAPA BASE</span><select aria-label="Mapa base" value={basemap} onChange={e => setBasemap(e.target.value)} style={{ ...inputStyle, width: "100%" }}><option>OpenStreetMap</option><option>Esri World Imagery</option></select><small>Requiere conexión a Internet.</small></div>
    </aside><section className="gis-map-panel"><div className="gis-map-heading"><span>{selectedProject?.name ?? "ÁREA DE ESTUDIO"}</span><span className="gis-map-status"><i/> MAPA ACTIVO</span></div><div className="gis-map" ref={mapElement} aria-label="Mapa GIS interactivo"/><div className="gis-map-footer"><span>CRS visualización: EPSG:4326</span><span>{layers.filter(l => l.visible).length} capas visibles · {datasets.length} datasets en el proyecto</span></div></section></div>
  </div>;
}

function createBasemap(name: string): L.TileLayer {
  if (name === "Esri World Imagery") return L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { attribution: "Tiles © Esri", maxZoom: 19 });
  return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19 });
}
const labelStyle: React.CSSProperties = { display: "block", marginBottom: 6, fontSize: 10, letterSpacing: "0.1em", color: "#94a3b8" };
const inputStyle: React.CSSProperties = { padding: "8px 9px", borderRadius: 6, border: "1px solid #334155", background: "#0f1b2d", color: "#e2e8f0", fontSize: 12, minWidth: 0 };
const buttonStyle: React.CSSProperties = { padding: "8px 10px", borderRadius: 6, border: "1px solid #3b82f6", background: "#1d4ed8", color: "white", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" };
const dangerButtonStyle: React.CSSProperties = { ...buttonStyle, borderColor: "#7f1d1d", background: "#7f1d1d" };
const smallButtonStyle: React.CSSProperties = { padding: "4px 7px", borderRadius: 5, border: "1px solid #334155", background: "#172438", color: "#cbd5e1", fontSize: 10, cursor: "pointer" };
const toolbarPanelStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginBottom: 16, padding: 14, border: "1px solid #263449", borderRadius: 10, background: "#0b1626" };
const controlGroupStyle: React.CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "end", gap: 8 };
const layerCardStyle: React.CSSProperties = { padding: 10, border: "1px solid #263449", borderRadius: 8, marginBottom: 9, background: "#0b1626" };
const styleGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr", gap: 5, margin: "10px 0" };
const miniLabelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5, fontSize: 11, color: "#a6b5c8", marginBottom: 8 };
