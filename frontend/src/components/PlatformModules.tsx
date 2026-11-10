import { useEffect, useState } from "react";
import {
  Activity, ArrowRight, Cable, Database, FileOutput, FolderKanban,
  RefreshCw, Settings2, ShieldCheck, Workflow
} from "lucide-react";

const API = "http://127.0.0.1:8000";

type Dataset = {
  id: number;
  project_id: number;
  name: string;
  description?: string | null;
  source_format?: string | null;
  source_filename?: string | null;
  geometry_type?: string | null;
  crs?: string | null;
  status?: string | null;
};
type Project = { id: number; name: string; status?: string; organization_id: number };
type Organization = { id: number; name: string; slug?: string };

type Props = { page: string; onNavigate: (page: string) => void };

const descriptions: Record<string, string> = {
  "Data Engineering": "Preparación y transformación de datos espaciales.",
  Integrations: "Fuentes externas y conexiones con otros sistemas.",
  Datasets: "Catálogo de datos espaciales registrados en la plataforma.",
  Deliverables: "Preparación y seguimiento de resultados y exportaciones.",
  Administration: "Estado de organizaciones, proyectos y entorno local.",
};

export default function PlatformModules({ page, onNavigate }: Props) {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      if (page === "Datasets") {
        const [response, projectResponse] = await Promise.all([
          fetch(`${API}/api/v1/datasets`),
          fetch(`${API}/api/v1/projects`),
        ]);
        if (!response.ok) throw new Error(`No se pudo cargar el catálogo (HTTP ${response.status}).`);
        if (!projectResponse.ok) throw new Error("No se pudo cargar la lista de proyectos.");
        const [rows, projectRows] = await Promise.all([response.json(), projectResponse.json()]);
        setDatasets(Array.isArray(rows) ? rows : []);
        setProjects(Array.isArray(projectRows) ? projectRows : []);
      } else if (page === "Administration") {
        const [orgResponse, projectResponse] = await Promise.all([
          fetch(`${API}/api/v1/organizations`),
          fetch(`${API}/api/v1/projects`),
        ]);
        if (!orgResponse.ok || !projectResponse.ok) throw new Error("No se pudieron consultar organizaciones y proyectos.");
        const [orgRows, projectRows] = await Promise.all([orgResponse.json(), projectResponse.json()]);
        setOrganizations(Array.isArray(orgRows) ? orgRows : []);
        setProjects(Array.isArray(projectRows) ? projectRows : []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido al consultar la API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* load when the selected module changes */ }, [page]);

  const filteredDatasets = datasets.filter((d) =>
    `${d.name} ${d.description ?? ""} ${d.source_format ?? ""} ${d.crs ?? ""}`
      .toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="platform-module">
      <div className="platform-module-heading">
        <div>
          <div className="eyebrow">SPATIALWORKS WORKSPACE</div>
          <h1>{page}</h1>
          <p>{descriptions[page] ?? "Módulo de la plataforma."}</p>
        </div>
        <button className="outline-button" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} /> {loading ? "Actualizando…" : "Actualizar"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {page === "Datasets" ? (
        <>
          <div className="module-summary-grid">
            <div className="module-summary-card"><Database size={19}/><span>Datasets registrados</span><strong>{datasets.length}</strong></div>
            <div className="module-summary-card"><FolderKanban size={19}/><span>Proyectos con datos</span><strong>{new Set(datasets.map(d => d.project_id)).size}</strong></div>
            <div className="module-summary-card"><ShieldCheck size={19}/><span>Origen de datos</span><strong>API local</strong></div>
          </div>
          <section className="module-panel">
            <div className="module-panel-head">
              <div><h2>Catálogo de datasets</h2><p>Datos obtenidos del backend. La eliminación de datasets no se ofrece desde esta pantalla.</p></div>
              <input className="module-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar por nombre, formato o CRS…" />
            </div>
            {loading ? <p className="module-empty">Cargando datasets…</p> : filteredDatasets.length === 0 ? (
              <div className="module-empty"><Database size={25}/><strong>{datasets.length ? "No hay coincidencias" : "Todavía no hay datasets"}</strong><p>Importa un archivo desde GIS Workspace para registrarlo y verlo aquí.</p><button className="projects-primary-button" onClick={() => onNavigate("GIS Workspace")}>Abrir GIS Workspace <ArrowRight size={15}/></button></div>
            ) : (
              <div className="module-table-wrap"><table className="module-table"><thead><tr><th>Dataset</th><th>Proyecto</th><th>Formato</th><th>Geometría</th><th>CRS</th><th>Estado</th></tr></thead><tbody>
                {filteredDatasets.map(d => <tr key={d.id}><td><strong>{d.name}</strong><small>{d.description || d.source_filename || `ID ${d.id}`}</small></td><td>{projects.find(p => p.id === d.project_id)?.name ?? `Proyecto ${d.project_id}`}</td><td>{d.source_format || "—"}</td><td>{d.geometry_type || "—"}</td><td>{d.crs || "—"}</td><td><span className="module-data-status">{d.status || "registrado"}</span></td></tr>)}
              </tbody></table></div>
            )}
          </section>
        </>
      ) : page === "Administration" ? (
        <>
          <div className="module-summary-grid">
            <div className="module-summary-card"><ShieldCheck size={19}/><span>Organizaciones</span><strong>{organizations.length}</strong></div>
            <div className="module-summary-card"><FolderKanban size={19}/><span>Proyectos</span><strong>{projects.length}</strong></div>
            <div className="module-summary-card"><Activity size={19}/><span>API</span><strong>Conectada si carga esta vista</strong></div>
          </div>
          <section className="module-panel"><div className="module-panel-head"><div><h2>Organizaciones</h2><p>Listado de organizaciones que devuelve la API.</p></div></div>
            {organizations.length ? <div className="module-record-list">{organizations.map(o => <div key={o.id} className="module-record"><ShieldCheck size={17}/><div><strong>{o.name}</strong><small>{o.slug || `ID ${o.id}`}</small></div></div>)}</div> : <p className="module-empty">No se han encontrado organizaciones.</p>}
          </section>
          <section className="module-panel"><div className="module-panel-head"><div><h2>Proyectos</h2><p>Los proyectos se siguen gestionando desde Projects.</p></div><button className="outline-button" onClick={() => onNavigate("Projects")}>Abrir Projects <ArrowRight size={15}/></button></div>
            <div className="module-record-list">{projects.map(p => <div key={p.id} className="module-record"><FolderKanban size={17}/><div><strong>{p.name}</strong><small>Organización {p.organization_id} · {p.status || "sin estado"}</small></div></div>)}</div>
          </section>
          <div className="module-note">Esta pantalla consulta los registros existentes. La gestión de usuarios, roles y permisos todavía no está disponible en la API actual.</div>
        </>
      ) : (
        <div className="module-roadmap-grid">
          {page === "Data Engineering" ? <>
            <ModuleCard icon={<Workflow size={20}/>} title="Validación de datos" status="Pendiente de motor" description="Definir reglas de geometría, CRS, campos obligatorios y calidad."/>
            <ModuleCard icon={<Activity size={20}/>} title="Procesos ETL" status="Sin ejecutar" description="Diseñar pasos de extracción, transformación y carga antes de conectarlos a un ejecutor."/>
            <ModuleCard icon={<Database size={20}/>} title="Entradas disponibles" status="Disponible" description="Los datasets registrados se pueden consultar en el catálogo." action="Ver datasets" onClick={() => onNavigate("Datasets")}/>
          </> : page === "Integrations" ? <>
            <ModuleCard icon={<Cable size={20}/>} title="Servicios GIS externos" status="Parcial" description="El mapa actual consume una capa externa de tuberías. No hay todavía un gestor de conexiones guardadas." action="Abrir GIS Workspace" onClick={() => onNavigate("GIS Workspace")}/>
            <ModuleCard icon={<Database size={20}/>} title="API local" status="Disponible" description="FastAPI expone operaciones para organizaciones, proyectos, datasets y mapas guardados."/>
            <ModuleCard icon={<Settings2 size={20}/>} title="Credenciales y conectores" status="Pendiente" description="Falta diseñar almacenamiento seguro de credenciales y pruebas de conexión."/>
          </> : <>
            <ModuleCard icon={<FileOutput size={20}/>} title="Exportación GIS" status="Pendiente" description="No existe aún un endpoint específico para generar entregables o exportaciones."/>
            <ModuleCard icon={<Database size={20}/>} title="Datos de origen" status="Disponible" description="Consulta el catálogo de datasets para identificar los datos que formarán parte de un entregable." action="Ver datasets" onClick={() => onNavigate("Datasets")}/>
            <ModuleCard icon={<FolderKanban size={20}/>} title="Mapas guardados" status="Disponible en GIS" description="Las configuraciones de mapa se guardan en el proyecto; todavía no son un sistema de entregables." action="Abrir GIS Workspace" onClick={() => onNavigate("GIS Workspace")}/>
          </>}
        </div>
      )}
    </div>
  );
}

function ModuleCard({ icon, title, status, description, action, onClick }: {
  icon: React.ReactNode; title: string; status: string; description: string;
  action?: string; onClick?: () => void;
}) {
  return <section className="module-feature-card"><div className="module-feature-icon">{icon}</div><span className="module-feature-status">{status}</span><h2>{title}</h2><p>{description}</p>{action && onClick && <button className="outline-button" onClick={onClick}>{action} <ArrowRight size={15}/></button>}</section>;
}
