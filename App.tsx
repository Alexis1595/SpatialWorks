import { useEffect, useState } from "react";
import GISWorkspace from "./components/GISWorkspace";
import ProjectsWorkspace from "./components/ProjectsWorkspace";
import PlatformModules from "./components/PlatformModules";
import {
  Activity,
  Boxes,
  BriefcaseBusiness,
  Cable,
  Database,
  FileStack,
  FolderKanban,
  Layers3,
  Map,
  Settings2,
  ShieldCheck,
  Workflow,
} from "lucide-react";

type Project = {
  id: number;
  organization_id: number;
  name: string;
  description: string | null;
  project_type: string;
  status: string;
  created_at: string;
};

const API = "http://127.0.0.1:8000";

const nav = [
  { title: "Overview", icon: Layers3 },
  { title: "Projects", icon: FolderKanban },
  { title: "GIS Workspace", icon: Map },
  { title: "Data Engineering", icon: Workflow },
  { title: "Integrations", icon: Cable },
  { title: "Datasets", icon: Database },
  { title: "Deliverables", icon: FileStack },
  { title: "Administration", icon: Settings2 },
];

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [apiStatus, setApiStatus] = useState<
    "checking" | "online" | "offline"
  >("checking");
  const [error, setError] = useState("");
  const [currentPage, setCurrentPage] = useState("Overview");

  useEffect(() => {
    Promise.all([
      fetch(`${API}/health`),
      fetch(`${API}/api/v1/projects`),
    ])
      .then(async ([health, response]) => {
        if (!health.ok || !response.ok) {
          throw new Error("API request failed");
        }

        const data: Project[] = await response.json();
        setProjects(data);
        setApiStatus("online");
        setError("");
      })
      .catch(() => {
        setApiStatus("offline");
        setError(
          "No se puede conectar con FastAPI. Comprueba que el backend esté iniciado en el puerto 8000."
        );
      });
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Layers3 size={23} />
          </div>
          <div>
            <strong>SpatialWorks</strong>
            <span>GIS & DATA PLATFORM</span>
          </div>
        </div>

        <div className="workspace-label">WORKSPACE</div>

        <div className="workspace">
          <div className="workspace-avatar">L</div>
          <div>
            <strong>Local environment</strong>
            <span>Development</span>
          </div>
        </div>

        <nav>
          {nav.map((item) => {
            const Icon = item.icon;

            return (
              <button
                key={item.title}
                className={`nav-item ${
                  currentPage === item.title ? "active" : ""
                }`}
                onClick={() => setCurrentPage(item.title)}
              >
                <Icon size={18} />
                <span>{item.title}</span>
                {item.title === "GIS Workspace" && (
                  <span className="nav-tag">GIS</span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          <ShieldCheck size={17} />
          <span>Local-only development</span>
          <span className="status-dot" />
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> {currentPage}
          </div>

          <div className="topbar-right">
            <span className={`api-pill ${apiStatus}`}>
              <i />
              API{" "}
              {apiStatus === "online"
                ? "Connected"
                : apiStatus === "offline"
                  ? "Disconnected"
                  : "Checking"}
            </span>
            <div className="avatar">DW</div>
          </div>
        </header>

        <section className="page">
          {currentPage === "GIS Workspace" ? (
            <GISWorkspace projects={projects} />
          ) : currentPage === "Projects" ? (
            <ProjectsWorkspace />
          ) : currentPage === "Overview" ? (
            <>
              <div className="welcome-row">
                <div>
                  <div className="eyebrow">
                    LOCAL DEVELOPMENT ENVIRONMENT
                  </div>
                  <h1>
                    Spatial data, <em>under control.</em>
                  </h1>
                  <p className="subtitle">
                    Your workspace for GIS, data engineering and systems
                    integration.
                  </p>
                </div>

                <div className="local-badge">
                  <span className="status-dot" />
                  Running locally
                </div>
              </div>

              {error && <div className="error-banner">{error}</div>}

              <div className="section-heading">
                <div>
                  <h2>Platform overview</h2>
                  <p>Project activity and technical workspace</p>
                </div>
                <button
                  className="outline-button"
                  onClick={() => window.location.reload()}
                >
                  <Activity size={16} /> Refresh status
                </button>
              </div>

              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-icon blue">
                    <BriefcaseBusiness size={19} />
                  </div>
                  <span>Active projects</span>
                  <strong>
                    {projects.filter((p) => p.status === "active").length}
                  </strong>
                  <small>Across your workspace</small>
                </div>

                <div className="stat-card">
                  <div className="stat-icon teal">
                    <Database size={19} />
                  </div>
                  <span>Datasets</span>
                  <strong>—</strong>
                  <small>Data catalog phase</small>
                </div>

                <div className="stat-card">
                  <div className="stat-icon violet">
                    <Workflow size={19} />
                  </div>
                  <span>Processing jobs</span>
                  <strong>—</strong>
                  <small>Worker phase</small>
                </div>

                <div className="stat-card">
                  <div className="stat-icon amber">
                    <Boxes size={19} />
                  </div>
                  <span>Integrations</span>
                  <strong>—</strong>
                  <small>Connector phase</small>
                </div>
              </div>

              <div className="content-grid">
                <section className="panel projects-panel">
                  <div className="panel-heading">
                    <div>
                      <h3>Recent projects</h3>
                      <p>Projects registered in the local database</p>
                    </div>
                    <span className="count-chip">
                      {projects.length} total
                    </span>
                  </div>

                  {projects.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-icon">
                        <FolderKanban size={23} />
                      </div>
                      <strong>Your workspace is ready</strong>
                      <p>
                        Once the API and database are running, create your
                        first project through the API documentation.
                      </p>
                      <a
                        href={`${API}/docs`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open API documentation ↗
                      </a>
                    </div>
                  ) : (
                    <div className="project-list">
                      {projects.slice(0, 6).map((project) => (
                        <div className="project-row" key={project.id}>
                          <div className="project-symbol">
                            <Map size={18} />
                          </div>
                          <div className="project-info">
                            <strong>{project.name}</strong>
                            <span>
                              {project.description || "No description"} ·{" "}
                              {project.project_type}
                            </span>
                          </div>
                          <span className="project-status">
                            {project.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="panel activity-panel">
                  <div className="panel-heading">
                    <div>
                      <h3>Technical modules</h3>
                      <p>Development roadmap</p>
                    </div>
                  </div>

                  <div className="module-row">
                    <div className="module-icon">
                      <ShieldCheck size={17} />
                    </div>
                    <div>
                      <strong>Core API</strong>
                      <span>Initial foundation</span>
                    </div>
                    <span className="module-state ready">READY</span>
                  </div>

                  <div className="module-row">
                    <div className="module-icon">
                      <Map size={17} />
                    </div>
                    <div>
                      <strong>GIS workspace</strong>
                      <span>Interactive map</span>
                    </div>
                    <span className="module-state planned">IN PROGRESS</span>
                  </div>

                  <div className="module-row">
                    <div className="module-icon">
                      <Workflow size={17} />
                    </div>
                    <div>
                      <strong>ETL engine</strong>
                      <span>Data pipelines</span>
                    </div>
                    <span className="module-state planned">PLANNED</span>
                  </div>

                  <div className="module-row">
                    <div className="module-icon">
                      <Cable size={17} />
                    </div>
                    <div>
                      <strong>Integrations</strong>
                      <span>External data sources</span>
                    </div>
                    <span className="module-state planned">PLANNED</span>
                  </div>
                </section>
              </div>

              <div className="footer-note">
                <span>SPATIALWORKS</span>
                <span>
                  Local-first · Modular architecture · Built for geospatial
                  workflows
                </span>
              </div>
            </>
          ) : (
            <PlatformModules
              page={currentPage}
              onNavigate={setCurrentPage}
            />
          )}
        </section>
      </main>
    </div>
  );
}

export default App;

